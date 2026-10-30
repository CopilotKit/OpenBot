/**
 * Proactive check-ins: a Bot looking through its owner's connected apps in the background, quietly,
 * and reaching out only when something needs them.
 *
 * NOT A NEW ORCHESTRATOR. Due settings are offered to the existing work queue and each check-in is
 * an ordinary headless AG-UI turn through the same turn runner routines use, so governance, audit and
 * Automatic Learning apply unchanged. The restriction is the initiator (see `restriction.ts`), which
 * the turn runner's `buildAgentFor` narrows on; this module adds three tools of its own and nothing
 * that can write outside OpenBot.
 *
 * A CHECK-IN IS USUALLY SILENT. It reads only what is new (`window.ts`) in a thread of its own, and
 * most end with nothing raised: one ledger row, no message, no second turn. Before any of that, the
 * gates that would make it pointless are read without the model: the person turned check-ins off,
 * paused the Bot, an admin turned them off, the Bot used its day's runs, the conversation is gone,
 * or the Bot can read none of the person's apps. Each writes a `skipped` row saying which.
 *
 * WHAT IT RAISES IS AN ITEM, NOT A MESSAGE. An item needs a source the check-in actually read, and
 * is refused if it repeats something open, something the person already has a task for, or something
 * they hid in the last thirty days. Open items stay until the person starts or hides one, or a later
 * check-in clears it as no longer needed. They reach the person through the ping (`ping.ts`): at most
 * one an hour per person, every Bot's waiting items folded into it, and in the app at once.
 *
 * STARTED WORK IS A TASK, in a conversation of its own (`tasks/*`). This engine marks the item
 * started and hands it over; it runs no task turns of its own.
 */

import type { HeadlessTool } from "@openbot/toolkit/headless-tools";
import type { TurnRunner } from "@openbot/toolkit/run-turn";
import { z } from "zod";
import type { AuditInitiator } from "../audit";
import type { MemoryStore } from "../memory/store";
import { REFUSAL_MARKER } from "../plugins/tools";
import type { WorkQueue } from "../work/queue";
import type {
  AttentionDelivery,
  AttentionPing,
  ProactiveAdmin,
  ProactiveRunTrigger,
  ProactiveSkipReason,
  TaskService,
} from "./contracts";
import {
  PROACTIVE_MEMORY_READS,
  proactiveInitiator,
  proactiveRunIdOf,
  refusalsFor,
} from "./restriction";
import type { PriorItems, ProactiveRead, ProactiveStore } from "./store";
import {
  clearInputSchema,
  linkKey,
  MAX_MEMORIES_PER_RUN,
  MAX_SUGGESTIONS_PER_RUN,
  ProactiveRefusedError,
  type ProactiveSetting,
  proactiveMemoryInputSchema,
  suggestionInputSchema,
  titleKey,
} from "./types";
import {
  type CheckInContext,
  checkInWindow,
  researchInstruction,
} from "./window";

export const PROACTIVE_RUN_KIND = "proactive.run";
/**
 * How long a check-in may hold its queue item and its `running` row. A turn is cut off at three
 * minutes, so anything still running at ten belongs to a replica that stopped.
 */
const RUN_LEASE_MS = 10 * 60_000;
/** A person pressing "Run now" twice in a minute gets one run. */
const RUN_NOW_GAP_MS = 10 * 60_000;
/**
 * How long a ping may sit written but not offered before the ping pass offers it again: long enough
 * that the replica which wrote it is plainly not about to.
 */
const UNOFFERED_AFTER_MS = 60_000;
/** Check-ins one Bot may run for one person in a day, until an admin says otherwise: hourly. */
export const DEFAULT_DAILY_RUNS = 24;

export type ProactiveScope = {
  ownerUserId: string;
  channelId: string;
  agentId: string;
  threadId: string;
};

export type ProactiveEngineDeps = {
  store: ProactiveStore;
  memory: Pick<MemoryStore, "formMemory">;
  queue: WorkQueue;
  owner: string;
  runTurn: TurnRunner;
  /** The person's conversation with this Bot, or null when they can no longer reach either. */
  resolveScope(
    ownerUserId: string,
    channelId: string,
    agentId: string,
  ): Promise<ProactiveScope | null>;
  /**
   * The owner's routing preference, as any notification takes it. Carries a ping until `attention`
   * is given: one message per ping, into one of the person's conversations with a Bot it names.
   */
  notify(
    scope: ProactiveScope,
    input: { id: string; text: string; kind: "reply" },
  ): Promise<void>;
  /** Delivery of a ping to the person's push devices, Slack and Teams (`delivery/*`). */
  attention?: AttentionDelivery;
  /** The admin's switch and daily cap (`admin/*`). Without it, on for everyone and 24 a day. */
  admin?: ProactiveAdmin;
  /** Opens a task for an item the person started (`tasks/*`). Without it, Start is refused. */
  tasks?: Pick<TaskService, "startFromItem">;
  /**
   * The connected-app reads this Bot can make for this person, by ref (see `appReads`). Empty means
   * a check-in could find nothing, so none is run. Without it, every check-in goes to the model.
   */
  readableApps?(ownerUserId: string, agentId: string): Promise<string[]>;
  /**
   * Unused: started items open a task through `tasks`, which runs the turn. Accepted until the
   * server's wiring stops passing it.
   */
  startTask?(
    scope: ProactiveScope,
    input: { runId: string; text: string; signal: AbortSignal },
  ): Promise<void>;
  catalogue: {
    listServers(): Promise<
      { id: string; title: string; tools: { ref: string }[] }[]
    >;
  };
  /** Names of the Bot's granted tools that are not reads, answered with a refusal if called. */
  deniedToolNames?(ownerUserId: string, agentId: string): Promise<string[]>;
  mintThreadId(): string;
  now?: () => Date;
};

/**
 * The reads among a Bot's tools that reach the person's apps: the tools a check-in may call
 * (`allowed`, the read classifier's answer) less the person's own memory, which every Bot can recall
 * and which holds nothing new for a check-in to find.
 */
export function appReads(
  tools: readonly { ref: string; name: string }[],
  allowed: ReadonlySet<string>,
): string[] {
  return tools
    .filter(
      (tool) =>
        (allowed.has(tool.ref) || allowed.has(tool.name)) &&
        !PROACTIVE_MEMORY_READS.has(tool.ref) &&
        !PROACTIVE_MEMORY_READS.has(tool.name),
    )
    .map((tool) => tool.ref);
}

/**
 * Why a new item repeats one the person already has, or null. Compared by normalized title and by
 * source link: the same mail raised under another wording is the same thing to them.
 */
export function repeatOf(
  prior: PriorItems,
  input: { title: string; sourceLink?: string | null },
): string | null {
  const key = titleKey(input.title);
  const link = linkKey(input.sourceLink);
  const same = (item: { title: string; sourceLink: string | null }) =>
    titleKey(item.title) === key ||
    (link !== null && linkKey(item.sourceLink) === link);
  const open = prior.open.find(same);
  if (open)
    return `"${open.title}" is already raised and still open. Do not raise it again.`;
  const task = prior.tasks.find(same);
  if (task)
    return `They already have a task for "${task.title}". Do not raise it again.`;
  const hidden = prior.hidden.find(same);
  if (hidden)
    return `They hid "${hidden.title}". Do not raise it, or anything like it, again.`;
  return null;
}

/** What the check-in is told of the past, from what the repeat check reads. */
function contextOf(prior: PriorItems): CheckInContext {
  return {
    open: prior.open.map(({ id, title }) => ({ id, title })),
    tasks: prior.tasks.map((task) => task.title),
    hidden: prior.hidden.map(({ title, sourceApp }) => ({ title, sourceApp })),
    started: prior.started.map((item) => item.title),
  };
}

const logged = (type: string) => (error: unknown) =>
  console.error(
    JSON.stringify({
      type,
      error: error instanceof Error ? error.name : "UnknownError",
      timestamp: new Date().toISOString(),
    }),
  );

export function createProactiveEngine(deps: ProactiveEngineDeps) {
  const now = deps.now ?? (() => new Date());
  const allowed = (ownerUserId: string) =>
    deps.admin
      ? deps.admin.proactiveAllowed(ownerUserId)
      : Promise.resolve(true);
  const dailyRuns = (agentId: string) =>
    deps.admin
      ? deps.admin.proactiveDailyRuns(agentId)
      : Promise.resolve(DEFAULT_DAILY_RUNS);
  /** Which setting a run belongs to, for the run's own tools. Local: the turn runs in this process. */
  const running = new Map<string, ProactiveSetting>();

  async function serverFor(ref: string) {
    const servers = await deps.catalogue.listServers();
    return servers.find((server) =>
      server.tools.some((tool) => tool.ref === ref),
    );
  }
  /** A read this run actually made, matched by ref or by the model-facing tool name. */
  function readMatching(reads: ProactiveRead[], named: string) {
    const spelled = named.startsWith("mcp__")
      ? named.slice(5).replace("__", "/")
      : named;
    return reads.find((read) => read.ref === named || read.ref === spelled);
  }

  function toolsForRun(
    setting: ProactiveSetting,
    runId: string,
  ): HeadlessTool[] {
    const tool = <T>(
      name: string,
      description: string,
      schema: z.ZodType<T>,
      run: (input: T) => Promise<unknown>,
    ): HeadlessTool => ({
      definition: {
        name,
        description,
        parameters: z.toJSONSchema(schema) as Record<string, unknown>,
      },
      async execute(args) {
        const parsed = schema.safeParse(args);
        if (!parsed.success)
          return `${REFUSAL_MARKER} ${parsed.error.issues[0]?.message ?? "Invalid arguments."}`;
        try {
          return JSON.stringify(await run(parsed.data));
        } catch (error) {
          if (error instanceof ProactiveRefusedError)
            return `${REFUSAL_MARKER} ${error.message}`;
          if (error instanceof Error && error.name.startsWith("Memory"))
            return `${REFUSAL_MARKER} ${error.message}`;
          throw error;
        }
      },
    });
    let memories = 0;
    return [
      tool(
        "suggest_next_step",
        "Raise one next step for the person, from something new you read in this check-in. They can start it as a task or hide it.",
        suggestionInputSchema,
        async (input) => {
          if (
            (await deps.store.countSuggestions(runId)) >=
            MAX_SUGGESTIONS_PER_RUN
          )
            throw new ProactiveRefusedError(
              `This check-in already raised ${MAX_SUGGESTIONS_PER_RUN} next steps.`,
            );
          // Every item says where it came from, and only from what this check-in itself read.
          const read = readMatching(
            await deps.store.readsFor(runId),
            input.sourceTool,
          );
          if (!read)
            throw new ProactiveRefusedError(
              "Name a tool you successfully read with in this check-in as sourceTool. A next step needs a source.",
            );
          const repeat = repeatOf(
            await deps.store.priorItems(setting.ownerUserId, setting.agentId),
            input,
          );
          if (repeat) throw new ProactiveRefusedError(repeat);
          const row = await deps.store.addSuggestion({
            ownerUserId: setting.ownerUserId,
            agentId: setting.agentId,
            settingId: setting.id,
            runId,
            title: input.title,
            detail: input.detail,
            sourceApp:
              (await serverFor(read.ref))?.title ??
              read.ref.split("/")[0] ??
              read.ref,
            sourceRef: read.ref,
            sourceLink: input.sourceLink ?? null,
          });
          return { suggested: row.id };
        },
      ),
      tool(
        "clear_next_step",
        "Clear one of your earlier next steps, listed as still open, that no longer needs the person: it was answered, done or cancelled.",
        clearInputSchema,
        async (input) => {
          const cleared = await deps.store.clearSuggestion(
            setting.id,
            input.suggestionId,
          );
          if (!cleared)
            throw new ProactiveRefusedError(
              "That is not one of your next steps still open. Clear only an id listed as still open.",
            );
          return { cleared: cleared.id };
        },
      ),
      tool(
        "form_memory",
        "Remember a durable fact about the person or their work that you read in this run. Provenance is recorded from the read itself and the person reviews it.",
        proactiveMemoryInputSchema,
        async (input) => {
          if (memories >= MAX_MEMORIES_PER_RUN)
            throw new ProactiveRefusedError(
              `This run already formed ${MAX_MEMORIES_PER_RUN} memories.`,
            );
          const read = readMatching(
            await deps.store.readsFor(runId),
            input.sourceTool,
          );
          if (!read)
            throw new ProactiveRefusedError(
              "A memory needs a source: name a tool you successfully read with in this run.",
            );
          const server = await serverFor(read.ref);
          memories += 1;
          return deps.memory.formMemory(setting.ownerUserId, {
            agentId: setting.agentId,
            content: input.content,
            sourceApp: server?.title ?? read.ref.split("/")[0] ?? read.ref,
            sourceRef: read.ref,
            ...(input.sourceLink ? { sourceLink: input.sourceLink } : {}),
            observedAt: read.at,
          });
        },
      ),
    ];
  }

  /**
   * Until delivery takes pings itself: one notification, into the person's conversation with the
   * Bot whose item is newest, falling back through the others. The text names every item's Bot.
   */
  async function notifyThroughConversation(ping: AttentionPing) {
    const newestFirst = [
      ...new Set(ping.items.map((item) => item.agentId).reverse()),
    ];
    for (const agentId of newestFirst) {
      const setting = await deps.store.forBot(ping.ownerUserId, agentId);
      if (!setting) continue;
      const scope = await deps.resolveScope(
        ping.ownerUserId,
        setting.channelId,
        agentId,
      );
      if (!scope) continue;
      await deps.notify(scope, {
        id: `ping:${ping.pingId}`,
        kind: "reply",
        text: ping.text,
      });
      return;
    }
  }

  /** Offer a written ping to delivery, then record that it was. Delivery dedupes a second offer. */
  async function offer(ping: AttentionPing) {
    if (deps.attention) await deps.attention.notifyAttention(ping);
    else await notifyThroughConversation(ping);
    await deps.store.pings.markOffered(ping.pingId);
  }

  /**
   * Ping this person if their hour allows and something waits. An admin who turned check-ins off
   * for them stops the pings too, not only the runs.
   */
  async function tryPing(ownerUserId: string) {
    if (!(await allowed(ownerUserId))) return null;
    const ping = await deps.store.pings.take(ownerUserId);
    if (ping) await offer(ping);
    return ping;
  }

  /**
   * The ping pass, every sweep: offer pings a stopped replica wrote but never offered, then ping
   * each person whose items waited for their hour to pass. One person's failure is logged and the
   * rest still go.
   */
  async function pingPass() {
    for (const ping of await deps.store.pings.unoffered(UNOFFERED_AFTER_MS))
      await offer(ping).catch(logged("proactive-ping-error"));
    for (const ownerUserId of await deps.store.pings.waiting())
      await tryPing(ownerUserId).catch(logged("proactive-ping-error"));
  }

  async function run(
    settingId: string,
    runId: string,
    trigger: ProactiveRunTrigger,
    signal: AbortSignal,
  ) {
    const setting = await deps.store.byId(settingId);
    if (!setting?.enabled) return;
    const skip = (reason: ProactiveSkipReason) =>
      deps.store.skipRun({ id: runId, setting, trigger, reason });
    // The gates, cheapest first, none of them a model call.
    if (await deps.store.personOff(setting.ownerUserId))
      return skip("off_person");
    if (await deps.store.paused(setting.ownerUserId, setting.agentId))
      return skip("paused");
    if (!(await allowed(setting.ownerUserId))) return skip("off_admin");
    if (
      (await deps.store.runsToday(setting.id)) >=
      (await dailyRuns(setting.agentId))
    )
      return skip("capped");
    const scope = await deps.resolveScope(
      setting.ownerUserId,
      setting.channelId,
      setting.agentId,
    );
    if (!scope) {
      await deps.store.recordRun(
        setting.id,
        "error",
        "This Bot or its conversation is no longer available to you, so it didn't check in.",
      );
      return skip("unreachable");
    }
    if (
      deps.readableApps &&
      (await deps.readableApps(setting.ownerUserId, setting.agentId)).length ===
        0
    )
      return skip("no_sources");
    // Read before this run is in the ledger, so the window opens at the check-in before it.
    const last = await deps.store.lastCheckIn(setting.id);
    const threadId = deps.mintThreadId();
    if (!(await deps.store.beginRun({ id: runId, setting, trigger, threadId })))
      return skip("busy");
    await deps.store.recordRun(setting.id, "running");
    const prior = await deps.store.priorItems(
      setting.ownerUserId,
      setting.agentId,
    );
    running.set(runId, setting);
    let failure: string | null = null;
    try {
      await deps.runTurn({
        ownerUserId: setting.ownerUserId,
        routineId: `proactive:${setting.id}`,
        agentId: setting.agentId,
        // A fresh thread: an hourly check-in must not carry every earlier one, and their mail.
        threadId,
        instruction: researchInstruction(
          setting,
          checkInWindow(last, now()),
          contextOf(prior),
        ),
        initiator: proactiveInitiator(runId),
        runId,
        signal,
      });
    } catch (error) {
      failure = error instanceof Error ? error.message : "The check-in failed.";
    } finally {
      running.delete(runId);
    }
    const [raised, reads] = await Promise.all([
      deps.store.countSuggestions(runId),
      deps.store.readsFor(runId),
    ]);
    await deps.store.finishRun(runId, {
      outcome: failure ? "failed" : raised > 0 ? "raised" : "quiet",
      itemsRaised: raised,
      reads: reads.length,
      error: failure,
    });
    await deps.store.recordRun(
      setting.id,
      failure ? "error" : "succeeded",
      failure,
    );
    // Items recorded before a failure are still the person's, so they wait for a ping too.
    if (raised > 0)
      await tryPing(setting.ownerUserId).catch(logged("proactive-ping-error"));
  }

  async function drain(
    kind: string,
    work: (
      payload: Record<string, unknown>,
      signal: AbortSignal,
    ) => Promise<void>,
  ) {
    const [item] = await deps.queue.claim({
      kind,
      owner: deps.owner,
      leaseMs: RUN_LEASE_MS,
      limit: 1,
      maxAttempts: 1,
    });
    if (!item) return false;
    const controller = new AbortController();
    const renew = setInterval(() => {
      void deps.queue
        .renew({
          kind,
          key: item.key,
          owner: deps.owner,
          leaseMs: RUN_LEASE_MS,
        })
        .then(
          (kept) => {
            if (!kept) controller.abort();
          },
          () => controller.abort(),
        );
    }, RUN_LEASE_MS / 3);
    renew.unref?.();
    try {
      await work(item.payload, controller.signal);
      await deps.queue.finish({ kind, key: item.key, owner: deps.owner });
    } catch (error) {
      // One attempt only: a background run is not worth repeating a partial read for.
      await deps.queue.release({
        kind,
        key: item.key,
        owner: deps.owner,
        delayMs: 60_000,
        reason: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      clearInterval(renew);
    }
    return true;
  }

  const payloadSchema = z.object({
    settingId: z.string().min(1),
    runId: z.string().min(1),
    trigger: z.enum(["schedule", "run_now"]).default("schedule"),
  });

  return {
    researchInstruction,
    /** Whether an admin left check-ins on for this person. */
    allowed,
    /** The headless tools for one proactive turn; empty for any other initiator. */
    async toolsForTurn(input: {
      ownerUserId: string;
      agentId: string;
      initiator: AuditInitiator;
    }): Promise<HeadlessTool[]> {
      const runId = proactiveRunIdOf(input.initiator);
      const setting = runId ? running.get(runId) : undefined;
      if (
        !runId ||
        !setting ||
        setting.ownerUserId !== input.ownerUserId ||
        setting.agentId !== input.agentId
      )
        return [];
      const own = toolsForRun(setting, runId);
      const ownNames = new Set(own.map((tool) => tool.definition.name));
      const denied = (
        (await deps.deniedToolNames?.(input.ownerUserId, input.agentId)) ?? []
      ).filter((name) => !ownNames.has(name));
      return [...own, ...refusalsFor([...new Set(denied)])];
    },
    async create(ownerUserId: string, input: unknown) {
      const parsed = input as { agentId?: unknown; channelId?: unknown };
      if (
        typeof parsed?.agentId !== "string" ||
        typeof parsed?.channelId !== "string" ||
        !(await deps.resolveScope(
          ownerUserId,
          parsed.channelId,
          parsed.agentId,
        ))
      )
        throw new ProactiveRefusedError(
          "Choose one of your Bots and a channel it is in.",
        );
      return deps.store.create(ownerUserId, input, deps.mintThreadId());
    },
    /** Queue a run now, unless one ran or was queued in the last ten minutes. */
    async runNow(ownerUserId: string, id: string) {
      const setting = await deps.store.get(ownerUserId, id);
      if (!setting.enabled)
        throw new ProactiveRefusedError("Turn background research on first.");
      if (
        setting.lastRunAt &&
        now().getTime() - setting.lastRunAt.getTime() < RUN_NOW_GAP_MS
      )
        throw new ProactiveRefusedError(
          "This Bot researched in the last ten minutes. Try again later.",
        );
      const runId = crypto.randomUUID();
      const bucket = Math.floor(now().getTime() / RUN_NOW_GAP_MS);
      const outcome = await deps.queue.offer({
        kind: PROACTIVE_RUN_KIND,
        key: `${setting.id}:now:${bucket}`,
        payload: { settingId: setting.id, runId, trigger: "run_now" },
      });
      return { queued: outcome === "queued" };
    },
    /** Hide: remembered for thirty days and told to every later check-in. */
    async dismiss(ownerUserId: string, suggestionId: string) {
      return deps.store.resolveSuggestion(
        ownerUserId,
        suggestionId,
        "dismissed",
      );
    },
    /**
     * The person chose to act on it: the item is started, once, and becomes a task in a conversation
     * of its own, where the ask runs as their own turn and every send or change meets approval.
     */
    async start(ownerUserId: string, suggestionId: string) {
      if (!deps.tasks)
        throw new ProactiveRefusedError("Starting a task isn't available yet.");
      const suggestion = await deps.store.suggestion(ownerUserId, suggestionId);
      const setting = await deps.store.get(ownerUserId, suggestion.settingId);
      if (
        !(await deps.resolveScope(
          ownerUserId,
          setting.channelId,
          suggestion.agentId,
        ))
      )
        throw new ProactiveRefusedError(
          "This Bot or its channel is no longer available to you.",
        );
      const started = await deps.store.resolveSuggestion(
        ownerUserId,
        suggestionId,
        "started",
      );
      try {
        const task = await deps.tasks.startFromItem({
          ownerUserId,
          item: {
            id: started.id,
            agentId: started.agentId,
            title: started.title,
            detail: started.detail,
            sourceApp: started.sourceApp,
            sourceLink: started.sourceLink,
          },
        });
        return { suggestion: started, task };
      } catch (error) {
        // No task to show for it: back on the list, so pressing Start again tries again.
        await deps.store.reopenSuggestion(ownerUserId, suggestionId);
        throw error;
      }
    },
    /**
     * One scheduling pass: close check-ins a stopped replica left running, ping whoever is due one,
     * offer what is due, then run at most one check-in.
     */
    async sweep() {
      await deps.store.closeStaleRuns(RUN_LEASE_MS);
      await pingPass();
      for (const setting of await deps.store.claimDue()) {
        const runId = crypto.randomUUID();
        await deps.queue.offer({
          kind: PROACTIVE_RUN_KIND,
          key: `${setting.id}:${runId}`,
          payload: { settingId: setting.id, runId, trigger: "schedule" },
        });
      }
      await drain(PROACTIVE_RUN_KIND, async (payload, signal) => {
        const { settingId, runId, trigger } = payloadSchema.parse(payload);
        await run(settingId, runId, trigger, signal);
      });
    },
  };
}
export type ProactiveEngine = ReturnType<typeof createProactiveEngine>;
