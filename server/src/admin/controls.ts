/**
 * The enterprise controls, installed once per API server and enforced at the existing boundaries.
 *
 * WHERE EACH SWITCH IS ENFORCED (all fail closed):
 *
 * - The computer boundary (`evaluateActionPolicy`, through {@link setPolicyOverlay}): every browser,
 *   shell, file and MCP action a Bot takes. Use Bots, Cloud browser use, Cloud computer use, Cloud
 *   network access, the network policy for navigations, and the MCP allowlist.
 * - The HTTP gate (`admin/gate.ts`), in front of the routes a member uses: starting a run, publishing
 *   a Team Bot, granting a folder on their own machine, connecting Slack or Teams, saving a custom
 *   rule, using the password manager, and the model allowlist.
 * - The stores themselves, wrapped in place ({@link guardDeliveryStore}, {@link guardHostAccess}),
 *   so a path that never crosses the HTTP gate (a Bot's own tool call, OpenTag pairing) is refused
 *   the same way.
 *
 * The computer boundary is synchronous, so it answers from a snapshot of the rows held here and kept
 * current by LISTEN/NOTIFY on {@link ENTERPRISE_TOPIC} plus a one-minute re-read. A snapshot that
 * never loaded refuses everything it is asked about. Every async check reads the database fresh.
 */

import { and, eq, inArray, like, sql } from "drizzle-orm";
import postgres from "postgres";
import {
  type AuditStore,
  addAuditTap,
  DEPLOYMENT_INITIATOR,
  recordAuditEvent,
} from "../audit";
import { isConfiguredAdmin } from "../auth/roles";
import {
  type PolicyContext,
  type PolicyDecision,
  setPolicyOverlay,
} from "../computer/policy";
import {
  type EgressPolicy,
  effectiveNetworkPolicy,
  egressDecision,
  pushEgressPolicies,
} from "../computer/policy-network";
import type { ComputerProvider } from "../computer/provider";
import type { Database } from "../db/client";
import { agentProfiles, agents, auditEvents } from "../db/schema";
import { createOtelEventExporter, type EventExporter } from "../telemetry/otel";
import { scrubCommand } from "../telemetry/scrub";
import {
  type Capability,
  type CapabilityRow,
  capabilityRefusal,
  type Member,
  resolveAllCapabilities,
  resolveCapability,
} from "./capabilities";
import {
  createEnterpriseStore,
  ENTERPRISE_TOPIC,
  type EnterpriseSettings,
  type EnterpriseStore,
  type NetworkPolicyRow,
} from "./settings-store";

/** Action Recording keeps 90 days, as Grok Bot's does. */
export const ACTION_RECORD_RETENTION_DAYS = 90;

type Snapshot = {
  rows: CapabilityRow[];
  admins: Set<string>;
  groupsByUser: Map<string, string[]>;
  settings: EnterpriseSettings;
  network: NetworkPolicyRow[];
  loadedAt: Date;
};

export type EnterpriseDeps = {
  database: Database;
  databaseUrl: string;
  auditStore: AuditStore;
  provider?: ComputerProvider;
  computerToken?: string;
  /** `provider/model` the built-in Bot runs on, for the model allowlist and usage view. */
  builtInModel?: string;
  /** Offboarding: ends sessions and deny-lists, and retires what a person granted. */
  people?: {
    revoke: (userId: string, by: string) => Promise<void>;
    retireOwned: (userId: string, by: string) => Promise<void>;
    restore: (userId: string) => Promise<void>;
  };
  initialAdminEmails?: readonly string[];
  env?: Record<string, string | undefined>;
};

export type EnterpriseControls = {
  store: EnterpriseStore;
  deps: EnterpriseDeps;
  exporter: EventExporter | undefined;
  snapshot: () => Snapshot | undefined;
  refresh: () => Promise<void>;
  capabilityFor: (userId: string, capability: Capability) => Promise<boolean>;
  capabilitiesFor: (userId: string) => Promise<Record<Capability, boolean>>;
  terminateMemberComputers: (
    userId: string,
    by: { id?: string; email: string },
  ) => Promise<{
    stopped: string[];
    failed: { botId: string; reason: string }[];
  }>;
  terminateInactiveComputers: () => Promise<{ stopped: string[] } | null>;
  pushNetworkPolicies: () => Promise<void>;
  policyForBot: (botId: string) => Promise<EgressPolicy>;
  offboard: (userId: string, by: string) => Promise<void>;
  stop: () => Promise<void>;
};

let installed: EnterpriseControls | undefined;

/** The running controls, or undefined in a test or a script that never installed them. */
export function enterpriseControls(): EnterpriseControls | undefined {
  return installed;
}

function refusal(matched: string, reason: string): PolicyDecision {
  return {
    allowed: false,
    mode: "enforce",
    matched,
    source: "deny",
    forward: false,
    reason,
  };
}

const COMPUTER_INTENTS = new Set([
  "read_file",
  "write_file",
  "list_files",
  "download_file",
  "run_command",
]);

function memberFrom(snapshot: Snapshot, userId: string): Member {
  return {
    role: snapshot.admins.has(userId) ? "admin" : "user",
    groups: snapshot.groupsByUser.get(userId) ?? [],
  };
}

/**
 * The overlay the computer boundary asks first. Exported for tests.
 */
export function decideFromSnapshot(
  snapshot: Snapshot | undefined,
  context: PolicyContext,
): PolicyDecision | null {
  if (!snapshot) {
    return refusal(
      "enterprise:unavailable",
      "This deployment's enterprise controls have not loaded yet, so the action was refused.",
    );
  }
  const member = memberFrom(snapshot, context.actor.id);
  const needed: Capability[] = ["useBots"];

  if (context.mcp?.server) {
    const allowlist = snapshot.settings.mcpAllowlist;
    if (allowlist.enabled && !allowlist.servers.includes(context.mcp.server)) {
      return refusal(
        "mcp_allowlist",
        `The MCP server "${context.mcp.server}" is not on this deployment's approved list, so ${context.mcp.tool} was not called.`,
      );
    }
  } else if (context.tool.name.startsWith("computer_")) {
    if (context.intent && COMPUTER_INTENTS.has(context.intent)) {
      needed.push("cloudComputer");
    } else {
      needed.push("cloudBrowser");
    }
    if (context.intent === "navigate") needed.push("cloudNetwork");
  }

  for (const capability of needed) {
    if (!resolveCapability(snapshot.rows, member, capability).allowed) {
      return refusal(`capability:${capability}`, capabilityRefusal(capability));
    }
  }

  /*
   * A navigation is checked against the network policy here as well as on the computer, so the
   * refusal is a sentence in the conversation rather than a browser error page. Only where it can be
   * decided without DNS: an IP-range rule needs the resolved address, which the computer's filter has
   * and this server does not.
   */
  if (context.intent === "navigate" && context.page.host) {
    const policy = effectiveNetworkPolicy(snapshot.network, member, true);
    const hasRanges = policy.rules.some((rule) => rule.type === "cidr");
    if (!hasRanges || /^[\d.:[\]]+$/.test(context.page.host)) {
      const port = portOf(context.page.url);
      const decision = egressDecision(policy, context.page.host, port);
      if (!decision.allowed) {
        return refusal(
          `network:${policy.from}`,
          `${decision.reason} An administrator can add it.`,
        );
      }
    }
  }
  return null;
}

function portOf(url: string): number {
  try {
    const parsed = new URL(url);
    return Number(parsed.port || (parsed.protocol === "http:" ? 80 : 443));
  } catch {
    return 443;
  }
}

async function loadSnapshot(store: EnterpriseStore): Promise<Snapshot> {
  /*
   * One after another, not Promise.all. Concurrent statements on one Bun SQL connection were seen to
   * swap prepared-statement result shapes ("bind message has 7 result formats but query has 1
   * columns"), and a snapshot is four small reads.
   */
  const rows = await store.capabilityRows();
  const admins = await store.adminIds();
  const settings = await store.settings();
  const network = await store.networkPolicies();
  const groups = [
    ...new Set([
      ...rows
        .filter((row) => row.scopeKind === "group")
        .map((row) => row.scopeId),
      ...network
        .filter((row) => row.scopeKind === "group")
        .map((row) => row.scopeId),
    ]),
  ];
  const groupsByUser = await store.groupMembers(groups);
  return {
    rows,
    admins,
    groupsByUser,
    settings,
    network,
    loadedAt: new Date(),
  };
}

/** Is this an action-recording row, and what should it say? */
function commandOf(payload: Record<string, unknown>): string | undefined {
  const command = payload.command;
  return typeof command === "string" && command.trim() ? command : undefined;
}

export async function installEnterpriseControls(
  deps: EnterpriseDeps,
): Promise<EnterpriseControls> {
  if (installed) return installed;
  const store = createEnterpriseStore(deps.database);
  const env = deps.env ?? process.env;
  let snapshot: Snapshot | undefined;

  const refresh = async () => {
    try {
      snapshot = await loadSnapshot(store);
    } catch (error) {
      console.error(
        JSON.stringify({
          type: "enterprise-controls-refresh-failed",
          note: snapshot
            ? "Still enforcing the last settings this server read."
            : "No settings have been read, so every capability-gated action is refused.",
          error: String(error),
          cause:
            error instanceof Error && error.cause
              ? String(error.cause)
              : undefined,
        }),
      );
    }
  };
  await refresh();
  setPolicyOverlay((context) => decideFromSnapshot(snapshot, context));

  const exporter = createOtelEventExporter(env);
  const removeTaps: (() => void)[] = [];
  if (exporter) removeTaps.push(addAuditTap((event) => exporter.emit(event)));

  /*
   * Action Recording: every shell command a Bot ran (or was refused), scrubbed, into its own table.
   * Read from the audit rows the computer gateway and the host broker already write, so the recorded
   * outcome is the one the trail holds.
   */
  removeTaps.push(
    addAuditTap((event) => {
      if (!snapshot?.settings.actionRecording) return;
      if (!event.eventType.startsWith("computer.action_")) return;
      const command = commandOf(event.payload);
      if (!command) return;
      const scrubbed = scrubCommand(command);
      const botId =
        typeof event.payload.bot === "string" ? event.payload.bot : null;
      // The gateway names the tool `action`; `tool` is accepted for any other writer.
      const named = event.payload.action ?? event.payload.tool;
      const toolName =
        typeof named === "string" ? named : "computer_run_command";
      const actor =
        event.actorUserId ??
        (typeof event.payload.actor === "string" ? event.payload.actor : null);
      const outcome = event.eventType.replace("computer.action_", "");
      void store
        .recordAction({
          surface: toolName.startsWith("host/") ? "local" : "cloud",
          botId,
          actorUserId: actor,
          toolName,
          command: scrubbed,
          outcome,
        })
        .catch((error) =>
          console.error(
            JSON.stringify({
              type: "action-record-failed",
              error: String(error),
            }),
          ),
        );
      exporter?.emit({
        eventType: "action.recorded",
        targetType: "computer",
        targetId: botId,
        actorUserId: event.actorUserId ?? null,
        initiatorKind: event.initiatorKind,
        initiatorId: event.initiatorId,
        payload: { bot: botId, tool: toolName, command: scrubbed, outcome },
        surface: "bot",
      });
    }),
  );

  const audit = (input: Parameters<typeof recordAuditEvent>[1]) =>
    recordAuditEvent(deps.auditStore, input).catch((error) =>
      console.error(
        JSON.stringify({
          type: "enterprise-audit-failed",
          eventType: input.eventType,
          error: String(error),
        }),
      ),
    );

  const policyForBot = async (botId: string): Promise<EgressPolicy> => {
    const current = snapshot;
    if (!current) return { mode: "deny_all", rules: [] };
    const [profile] = await deps.database
      .select({ owner: agentProfiles.ownerUserId })
      .from(agentProfiles)
      .where(eq(agentProfiles.agentId, botId))
      .limit(1);
    const member: Member = profile?.owner
      ? await store.member(profile.owner)
      : { role: "user", groups: [] };
    const cloudNetwork = resolveCapability(
      current.rows,
      member,
      "cloudNetwork",
    ).allowed;
    const { from: _from, ...policy } = effectiveNetworkPolicy(
      current.network,
      member,
      cloudNetwork,
    );
    return policy;
  };

  let pushing: Promise<void> | undefined;
  const pushNetworkPolicies = async () => {
    if (!deps.provider) return;
    if (pushing) return pushing;
    pushing = (async () => {
      try {
        const report = await pushEgressPolicies({
          provider: deps.provider as ComputerProvider,
          token: deps.computerToken,
          policyForBot,
        });
        if (report.failed.length > 0) {
          console.warn(
            JSON.stringify({
              type: "egress-policy-push-incomplete",
              ...report,
            }),
          );
        }
      } catch (error) {
        console.error(
          JSON.stringify({
            type: "egress-policy-push-failed",
            error: String(error),
          }),
        );
      } finally {
        pushing = undefined;
      }
    })();
    return pushing;
  };

  const ownedBots = async (userId: string) =>
    (
      await deps.database
        .select({ agentId: agentProfiles.agentId })
        .from(agentProfiles)
        .where(eq(agentProfiles.ownerUserId, userId))
    ).map((row) => row.agentId);

  const terminateMemberComputers: EnterpriseControls["terminateMemberComputers"] =
    async (userId, by) => {
      const result = {
        stopped: [] as string[],
        failed: [] as { botId: string; reason: string }[],
      };
      if (!deps.provider) return result;
      for (const botId of await ownedBots(userId)) {
        try {
          const { wasRunning } = await deps.provider.stop(botId);
          if (wasRunning) result.stopped.push(botId);
        } catch (error) {
          result.failed.push({
            botId,
            reason: error instanceof Error ? error.message : String(error),
          });
        }
      }
      await audit({
        eventType: "computer.terminated",
        targetType: "person",
        targetId: userId,
        ...(by.id ? { actorUserId: by.id } : {}),
        payload: {
          by: by.email,
          stopped: result.stopped,
          failed: result.failed,
          note: "Running Bots stopped; durable disks kept; each Bot gets a fresh computer next session.",
        },
      });
      return result;
    };

  /**
   * Stop every running computer nobody has used for `inactiveComputerDays`.
   *
   * One replica at a time, under a transaction-scoped advisory lock, so two servers do not both
   * write the audit row. Idleness is read from the audit trail, as the idle culler reads it, so
   * nothing here dials a computer to ask.
   */
  const terminateInactiveComputers = async () => {
    const days = snapshot?.settings.inactiveComputerDays ?? 30;
    if (!deps.provider || days <= 0) return null;
    /*
     * The lock is held on a connection of its own, so the work below (reads, stops, audit rows) uses
     * the pool normally. Holding it inside a pool transaction while writing through the pool is how
     * a small pool deadlocks.
     */
    const lockConnection = postgres(deps.databaseUrl, { max: 1 });
    try {
      const [lock] = await lockConnection<
        { held: boolean }[]
      >`select pg_try_advisory_lock(4192011) as held`;
      if (!lock?.held) return null;
      const tx = deps.database;
      const running = (await (deps.provider as ComputerProvider).list()).filter(
        (computer) => computer.status === "running",
      );
      if (running.length === 0) return { stopped: [] };
      const bot = sql<string>`${auditEvents.payload}->>'bot'`;
      const used = new Map(
        (
          await tx
            .select({ bot, last: sql<string>`max(${auditEvents.createdAt})` })
            .from(auditEvents)
            .where(
              and(
                like(auditEvents.eventType, "computer.%"),
                inArray(
                  bot,
                  running.map((computer) => computer.botId),
                ),
              ),
            )
            .groupBy(bot)
        ).map((row) => [row.bot, new Date(row.last)] as const),
      );
      const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
      const stopped: string[] = [];
      for (const computer of running) {
        const since =
          used.get(computer.botId) ??
          (computer.startedAt ? new Date(computer.startedAt) : undefined);
        if (!since || since.getTime() > cutoff) continue;
        try {
          await (deps.provider as ComputerProvider).stop(computer.botId);
          stopped.push(computer.botId);
          await audit({
            eventType: "computer.terminated_inactive",
            targetType: "computer",
            targetId: computer.botId,
            initiator: DEPLOYMENT_INITIATOR,
            payload: {
              bot: computer.botId,
              idleSince: since.toISOString(),
              inactiveDays: days,
            },
          });
        } catch (error) {
          console.warn(
            JSON.stringify({
              type: "inactive-computer-stop-failed",
              botId: computer.botId,
              error: String(error),
            }),
          );
        }
      }
      await lockConnection`select pg_advisory_unlock(4192011)`;
      return { stopped };
    } finally {
      await lockConnection.end({ timeout: 5 });
    }
  };

  const offboard = async (userId: string, by: string) => {
    await deps.people?.retireOwned(userId, by).catch((error) =>
      console.error(
        JSON.stringify({
          type: "offboard-retire-failed",
          userId,
          error: String(error),
        }),
      ),
    );
    await terminateMemberComputers(userId, { email: by }).catch((error) =>
      console.error(
        JSON.stringify({
          type: "offboard-computers-failed",
          userId,
          error: String(error),
        }),
      ),
    );
  };

  // Every server hears a change, including the one that made it.
  const connection = postgres(deps.databaseUrl, { max: 1 });
  const onChange = () => {
    void refresh().then(() => pushNetworkPolicies());
  };
  await connection
    .listen(ENTERPRISE_TOPIC, onChange, onChange)
    .catch((error) => {
      console.error(
        JSON.stringify({
          type: "enterprise-listen-failed",
          note: "Changes made on another server reach this one within a minute instead of at once.",
          error: String(error),
        }),
      );
    });

  const timers = [
    setInterval(() => void refresh(), 60_000),
    setInterval(() => void pushNetworkPolicies(), 30_000),
    setInterval(() => {
      void terminateInactiveComputers().catch((error) =>
        console.error(
          JSON.stringify({
            type: "inactive-computer-sweep-failed",
            error: String(error),
          }),
        ),
      );
      void store
        .purgeActions(
          new Date(
            Date.now() - ACTION_RECORD_RETENTION_DAYS * 24 * 60 * 60 * 1000,
          ),
        )
        .catch((error) =>
          console.error(
            JSON.stringify({
              type: "action-record-purge-failed",
              error: String(error),
            }),
          ),
        );
    }, 60 * 60_000),
  ];
  for (const timer of timers) timer.unref?.();
  void pushNetworkPolicies();

  installed = {
    store,
    deps,
    exporter,
    snapshot: () => snapshot,
    refresh,
    capabilityFor: async (userId, capability) =>
      resolveCapability(
        await store.capabilityRows(),
        await store.member(userId),
        capability,
      ).allowed,
    capabilitiesFor: async (userId) =>
      resolveAllCapabilities(
        await store.capabilityRows(),
        await store.member(userId),
      ),
    terminateMemberComputers,
    terminateInactiveComputers,
    pushNetworkPolicies,
    policyForBot,
    offboard,
    stop: async () => {
      for (const timer of timers) clearInterval(timer);
      for (const remove of removeTaps) remove();
      setPolicyOverlay(null);
      installed = undefined;
      await Promise.allSettled([connection.end(), exporter?.shutdown()]);
    },
  };
  return installed;
}

/** For the break-glass rule, which is decided before the controls may be installed. */
export function isBreakGlass(
  email: string,
  initialAdminEmails: readonly string[],
): boolean {
  return isConfiguredAdmin(email, initialAdminEmails);
}

/* ------------------------------ guarding stores in place ------------------------------ */

type DeliveryLike = {
  bind(input: {
    ownerUserId: string;
    transport: string;
    realm: string;
    identity: string;
    channelId?: string | null;
    agentId?: string | null;
  }): Promise<{ id: string }>;
  removeBinding(owner: string, id: string): Promise<void>;
};

/**
 * Refuse a Slack or Teams connection for somebody without "Add Bots to Slack and Teams", and put
 * every connection and disconnection on the trail. In place, so every holder of the store is covered.
 */
export function guardDeliveryStore<T extends DeliveryLike>(
  store: T,
  auditStore: AuditStore,
  refuse: (message: string) => Error,
): T {
  const bind = store.bind.bind(store);
  const removeBinding = store.removeBinding.bind(store);
  store.bind = (async (input: Parameters<T["bind"]>[0]) => {
    const controls = enterpriseControls();
    if (
      controls &&
      (input.transport === "slack" || input.transport === "teams")
    ) {
      let allowed = false;
      try {
        allowed = await controls.capabilityFor(input.ownerUserId, "slackTeams");
      } catch {
        allowed = false;
      }
      if (!allowed) throw refuse(capabilityRefusal("slackTeams"));
    }
    const bound = await bind(input);
    await recordAuditEvent(auditStore, {
      eventType: "delivery.linked",
      targetType: "delivery_binding",
      targetId: bound.id,
      actorUserId: input.ownerUserId,
      payload: {
        transport: input.transport,
        realm: input.realm,
        channelId: input.channelId ?? null,
        agentId: input.agentId ?? null,
      },
    }).catch(() => undefined);
    return bound;
  }) as T["bind"];
  store.removeBinding = (async (owner: string, id: string) => {
    await removeBinding(owner, id);
    await recordAuditEvent(auditStore, {
      eventType: "delivery.unlinked",
      targetType: "delivery_binding",
      targetId: id,
      actorUserId: owner,
      payload: {},
    }).catch(() => undefined);
  }) as T["removeBinding"];
  return store;
}

type HostAccessLike = {
  requestFolderGrant(input: {
    actorId: string;
    botId: string;
    botName: string;
    writable?: boolean;
  }): Promise<unknown>;
  callHost(input: {
    actorId: string;
    botId: string;
    kind: string;
    command?: string;
  }): Promise<unknown>;
};

/** Refuse the member's own machine to somebody without "Local computer access", and record commands. */
export function guardHostAccess<T extends HostAccessLike>(
  broker: T,
  refuse: (message: string) => Error,
): T {
  const requestFolderGrant = broker.requestFolderGrant.bind(broker);
  const callHost = broker.callHost.bind(broker);
  const allowed = async (actorId: string) => {
    const controls = enterpriseControls();
    if (!controls) return true;
    try {
      return (
        (await controls.capabilityFor(actorId, "useBots")) &&
        (await controls.capabilityFor(actorId, "localComputer"))
      );
    } catch {
      return false;
    }
  };
  broker.requestFolderGrant = (async (
    input: Parameters<T["requestFolderGrant"]>[0],
  ) => {
    if (!(await allowed(input.actorId)))
      throw refuse(capabilityRefusal("localComputer"));
    return requestFolderGrant(input);
  }) as T["requestFolderGrant"];
  broker.callHost = (async (input: Parameters<T["callHost"]>[0]) => {
    if (!(await allowed(input.actorId)))
      throw refuse(capabilityRefusal("localComputer"));
    const controls = enterpriseControls();
    const record = (outcome: string) => {
      if (input.kind !== "run_command" || !input.command) return;
      if (!controls?.snapshot()?.settings.actionRecording) return;
      void controls.store
        .recordAction({
          surface: "local",
          botId: input.botId,
          actorUserId: input.actorId,
          toolName: "host/run_command",
          command: scrubCommand(input.command),
          outcome,
        })
        .catch(() => undefined);
    };
    try {
      const result = await callHost(input);
      record("allowed");
      return result;
    } catch (error) {
      record("failed");
      throw error;
    }
  }) as T["callHost"];
  return broker;
}

type RoutineLike = {
  create(input: {
    ownerUserId: string;
    agentId?: string;
    channelId?: string;
    cron?: string;
    timezone?: string;
  }): Promise<{ id: string }>;
  update(ownerUserId: string, id: string, patch: object): Promise<unknown>;
  remove(ownerUserId: string, id: string): Promise<void>;
  setEnabled(ownerUserId: string, id: string, enabled: boolean): Promise<void>;
};

/**
 * Put every routine change on the trail, whoever made it: the screen, or a Bot through its tools.
 * In place, so the tool registry that already holds this store is covered too.
 */
export function auditRoutineStore<T extends RoutineLike>(
  store: T,
  auditStore: AuditStore,
): T {
  const create = store.create.bind(store);
  const update = store.update.bind(store) as (
    ...args: unknown[]
  ) => Promise<unknown>;
  const remove = store.remove.bind(store);
  const setEnabled = store.setEnabled.bind(store);
  const write = (input: Parameters<typeof recordAuditEvent>[1]) =>
    recordAuditEvent(auditStore, input).catch(() => undefined);

  store.create = (async (input: Parameters<T["create"]>[0]) => {
    const routine = await create(input);
    await write({
      eventType: "routine.created",
      targetType: "routine",
      targetId: routine.id,
      actorUserId: input.ownerUserId,
      payload: {
        agentId: input.agentId ?? null,
        channelId: input.channelId ?? null,
        cron: input.cron ?? null,
        timezone: input.timezone ?? null,
      },
    });
    return routine;
  }) as T["create"];
  store.update = (async (...args: unknown[]) => {
    const result = await update(...args);
    const [ownerUserId, id, changes] = args as [unknown, unknown, unknown];
    await write({
      eventType: "routine.updated",
      targetType: "routine",
      ...(typeof id === "string" ? { targetId: id } : {}),
      ...(typeof ownerUserId === "string" ? { actorUserId: ownerUserId } : {}),
      payload: {
        changed:
          changes && typeof changes === "object"
            ? Object.keys(changes as object)
            : [],
      },
    });
    return result;
  }) as T["update"];
  store.remove = (async (ownerUserId: string, id: string) => {
    await remove(ownerUserId, id);
    await write({
      eventType: "routine.deleted",
      targetType: "routine",
      targetId: id,
      actorUserId: ownerUserId,
      payload: {},
    });
  }) as T["remove"];
  store.setEnabled = (async (
    ownerUserId: string,
    id: string,
    enabled: boolean,
  ) => {
    await setEnabled(ownerUserId, id, enabled);
    await write({
      eventType: "routine.enabled_changed",
      targetType: "routine",
      targetId: id,
      actorUserId: ownerUserId,
      payload: { enabled },
    });
  }) as T["setEnabled"];
  return store;
}

/* ------------------------------ headless turns ------------------------------ */

/**
 * Whether a turn nobody started from the browser may run, and the sentence to refuse it with.
 *
 * The HTTP gate (`gate.ts`) applies "Use Bots" and the model allowlist to a browser run. Routines,
 * Run now, responsibilities, follow-ups, group turns, delivery conversations and Slack, Teams and
 * SMS messages never cross it: they run through the shared headless turn runner, which asks here.
 * The allowlist is decided the way the gate decides it before a run: a built-in Bot runs on the
 * deployment's configured model, so that model is known; a remote Bot chooses its own and is
 * checked only by what it streams. Fails closed when the controls cannot be read.
 */
export async function headlessTurnRefusal(input: {
  ownerUserId: string;
  agentId: string;
}): Promise<string | null> {
  const controls = installed;
  if (!controls) return null;
  try {
    if (!(await controls.capabilityFor(input.ownerUserId, "useBots")))
      return capabilityRefusal("useBots");
    const allowlist = controls.snapshot()?.settings.modelAllowlist;
    if (!allowlist?.enabled) return null;
    const [row] = await controls.deps.database
      .select({ type: agents.type })
      .from(agents)
      .where(eq(agents.id, input.agentId))
      .limit(1);
    const model =
      row?.type === "built_in" ? controls.deps.builtInModel : undefined;
    if (!model || allowlist.models.includes(model)) return null;
    await controls.store
      .recordModelUsage({
        userId: input.ownerUserId,
        agentId: input.agentId,
        threadId: null,
        runId: null,
        model,
        source: "configured",
        allowed: false,
      })
      .catch(() => undefined);
    await recordAuditEvent(controls.deps.auditStore, {
      eventType: "model.refused",
      targetType: "agent",
      targetId: input.agentId,
      actorUserId: input.ownerUserId,
      payload: { model, source: "configured", headless: true },
    }).catch(() => undefined);
    return `This Bot runs on ${model}, which is not on this deployment's model allowlist. An administrator can add it.`;
  } catch (error) {
    console.error(
      JSON.stringify({
        type: "headless-capability-check-failed",
        agentId: input.agentId,
        error: String(error),
      }),
    );
    return "This deployment's enterprise controls could not be checked, so the Bot did not run.";
  }
}
