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
 * paused the Bot, an admin turned them off, the Bot used its day's runs, the Bot is no longer theirs
 * to use, or the Bot can read nothing the person connected with their own account (`scope.ts`). Each writes
 * a `skipped` row saying which.
 *
 * WHAT IT RAISES IS AN ITEM, NOT A MESSAGE. An item needs a source the check-in actually read, and
 * is refused if it repeats something open, something the person already has a task for, or something
 * they hid in the last thirty days, from any of their Bots: the same request is raised once for the
 * person, whichever Bot finds it first. Open items stay until the person starts or hides one, or a
 * later check-in clears it as no longer needed. They reach the person through the ping (`ping.ts`):
 * at most one an hour per person, every Bot's waiting items folded into it, and in the app at once.
 *
 * STARTED WORK IS A TASK, in a conversation of its own (`tasks/*`). This engine marks the item
 * started and hands it over; it runs no task turns of its own.
 */

import type { HeadlessTool } from "@openbot/toolkit/headless-tools";
import { EmptyTurnError, type TurnRunner } from "@openbot/toolkit/run-turn";
import { z } from "zod";
import { recordHeadlessUsage } from "../admin/controls";
import type { AuditInitiator } from "../audit";
import type { MemoryStore } from "../memory/store";
import { REFUSAL_MARKER } from "../plugins/tools";
import type { WorkQueue } from "../work/queue";
import type {
  AttentionDelivery,
  AttentionPing,
  CheckInHealth,
  CheckInSourceKind,
  ProactiveAdmin,
  ProactiveRunTrigger,
  ProactiveSkipReason,
  RunNowResponse,
  TaskService,
} from "./contracts";
import {
  proactiveInitiator,
  proactiveRunIdOf,
  refusalsFor,
} from "./restriction";
import {
  type CheckInApp,
  type CheckInScope,
  type CheckInSource,
  serverOfRef,
} from "./scope";
import {
  normalisedPage,
  pageHashOf,
  pageHost,
  publicPageAddress,
} from "./source";
import {
  PROACTIVE_RUN_KIND,
  type PriorItems,
  type ProactiveRead,
  type ProactiveStore,
  type ProactiveRunRow,
  STOPPED_BEFORE_FINISHING,
  unreachedApps,
  unreachedError,
} from "./store";
import {
  clearInputSchema,
  PAGE_UNREAD,
  pageSuggestionInputSchema,
  MAX_MEMORIES_PER_RUN,
  MAX_SUGGESTIONS_PER_RUN,
  ProactiveRefusedError,
  type ProactiveSetting,
  proactiveMemoryInputSchema,
  SKIPPED_BECAUSE,
  sameThing,
  suggestionInputSchema,
} from "./types";
import {
  type CheckInContext,
  checkInWindow,
  pageInstruction,
  researchInstruction,
} from "./window";

export { PROACTIVE_RUN_KIND };

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
/** How many people one ping pass pings at most, so a backlog drains over a few sweeps. */
const PINGS_PER_PASS = 20;
/** How many of its own open items, tasks and hidden items a check-in is told of, newest first. */
const OWN_LISTED = 50;
/** Check-ins one Bot may run for one person in a day, until an admin says otherwise: hourly. */
export const DEFAULT_DAILY_RUNS = 24;

export type ProactiveEngineDeps = {
  store: ProactiveStore;
  /**
   * Where a check-in's `form_memory` writes. Absent in an edition without memory
   * (`editionHasMemory`), and then a check-in is offered no `form_memory` and told nothing about it.
   */
  memory?: Pick<MemoryStore, "formMemory">;
  queue: WorkQueue;
  owner: string;
  runTurn: TurnRunner;
  /**
   * Whether the person may still use this Bot: not revoked, and the Bot theirs to use. A check-in
   * belongs to its Bot and has no conversation, so this is its whole reach check, at create, at each
   * run and at Work on it.
   */
  canUseBot(ownerUserId: string, agentId: string): Promise<boolean>;
  /** Delivery of a ping to the person's push devices, Slack and Teams (`delivery/*`). */
  attention: AttentionDelivery;
  /** The admin's switch and daily cap (`admin/*`). Without it, on for everyone and 24 a day. */
  admin?: ProactiveAdmin;
  /** Opens a task for an item the person started (`tasks/*`). Without it, Start is refused. */
  tasks?: Pick<TaskService, "startFromItem">;
  /**
   * The apps this person connected with their own account that this Bot can read, with the reads
   * in each (see `scope.ts`). Empty means a check-in could find nothing, so none is run; otherwise
   * the instruction names them. Without it, every check-in goes to the model and names none.
   */
  readableApps?(ownerUserId: string, agentId: string): Promise<CheckInApp[]>;
  catalogue: {
    listServers(): Promise<
      { id: string; title: string; tools: { ref: string }[] }[]
    >;
  };
  /** Names of the Bot's granted tools that are not reads, answered with a refusal if called. */
  deniedToolNames?(ownerUserId: string, agentId: string): Promise<string[]>;
  /**
   * The Bot's tool that reads a web page by its address, or null when it holds none. A `page`
   * check-in reads its one address with it; without one it can't look.
   */
  pageReader?(
    ownerUserId: string,
    agentId: string,
  ): Promise<{ ref: string; name: string } | null>;
  /**
   * What a check-in on something this Bot read with the named tool would read (`scope.ts`): how an
   * accepted offer's kind is worked out, from the tool and never from a label.
   */
  sourceOf?(
    ownerUserId: string,
    agentId: string,
    toolName: string,
  ): Promise<CheckInSource>;
  /** The Bot's name as the person knows it, for the sentences `health` says. */
  botName?(ownerUserId: string, agentId: string): Promise<string | null>;
  /**
   * Read one page through the Bot's page-read tool, as the person and under the run's proactive
   * initiator, so grants, policy and the audit trail apply as to any call (`PluginStore.callTool`),
   * and the door admits it only for this check-in's own address. Its text, or a throw.
   */
  readPage?(input: {
    ownerUserId: string;
    agentId: string;
    ref: string;
    link: string;
    initiator: AuditInitiator;
  }): Promise<string>;
  mintThreadId(): string;
  now?: () => Date;
};

/**
 * Why a new item repeats one the person already has, or null. Compared by normalized title and by
 * source link (`sameThing`), against every one of their Bots: the same request is one thing to them
 * whichever Bot found it, so it is raised once, and what they hid stays hidden from all of them.
 *
 * Another Bot's item is never quoted back. This Bot may not be able to read what that one read, and
 * a title is written from somebody's mail.
 */
export function repeatOf(
  prior: PriorItems,
  input: { agentId: string; title: string; sourceLink?: string | null },
): string | null {
  const same = (item: { title: string; sourceLink: string | null }) =>
    sameThing(input, item);
  const open = prior.open.find(same);
  if (open)
    return open.agentId === input.agentId
      ? `"${open.title}" is already raised and still open. Do not raise it again.`
      : "Another of their Bots already raised this, and it is still open. Do not raise it again.";
  const task = prior.tasks.find(same);
  if (task)
    return task.agentId === input.agentId
      ? `They already have a task for "${task.title}". Do not raise it again.`
      : "They already have a task for this from another of their Bots. Do not raise it again.";
  const hidden = prior.hidden.find(same);
  if (hidden)
    return hidden.agentId === input.agentId
      ? `They hid "${hidden.title}". Do not raise it, or anything like it, again.`
      : "They hid this when another of their Bots raised it. Do not raise it, or anything like it, again.";
  return null;
}

/**
 * What the check-in is told of the past, from what the repeat check reads: this Bot's own items and
 * tasks only. Another Bot's are kept from it for the reason {@link repeatOf} never quotes them.
 */
function contextOf(prior: PriorItems, agentId: string): CheckInContext {
  const own = <T extends { agentId: string }>(items: T[]) =>
    items.filter((item) => item.agentId === agentId);
  return {
    open: own(prior.open)
      .slice(0, OWN_LISTED)
      .map(({ id, title }) => ({ id, title })),
    tasks: own(prior.tasks)
      .slice(0, OWN_LISTED)
      .map((task) => task.title),
    hidden: own(prior.hidden)
      .slice(0, OWN_LISTED)
      .map(({ title, sourceApp }) => ({ title, sourceApp })),
    started: prior.started.map((item) => item.title),
  };
}

/**
 * How a check-in ended, from how its turn ended, what it raised, and what the audit trail says it
 * read: the outcome its ledger row records, and the error with it.
 *
 * - A turn that broke off failed, whatever it read.
 * - An app it could not reach, with nothing raised, is a failure too, never quiet: the person would
 *   read "nothing needed you" about an app nobody could open. Its error names the apps, which is the
 *   reason they read (`unreachedError`).
 * - A turn that read and said nothing ended as the instruction allows: most check-ins should record
 *   nothing, and a model that found nothing often adds no closing line either. That is quiet, or
 *   raised when it raised something. One that said nothing and read nothing is still a failure.
 * - Raised with an app it could not reach is raised, and keeps that error, so the next check-in's
 *   window opens from before it (`windowStart`) and reads what that app had meanwhile.
 */
function outcomeOf(input: {
  thrown: unknown;
  raised: number;
  reads: number;
  unreached: readonly string[];
}): { outcome: "quiet" | "raised" | "failed"; error: string | null } {
  const silent = input.thrown instanceof EmptyTurnError;
  if (input.thrown && !silent)
    return {
      outcome: "failed",
      error:
        input.thrown instanceof Error
          ? input.thrown.message
          : "The check-in failed.",
    };
  const missed =
    input.unreached.length > 0 ? unreachedError(input.unreached) : null;
  if (missed && input.raised === 0) return { outcome: "failed", error: missed };
  if (silent && input.reads === 0)
    return { outcome: "failed", error: (input.thrown as Error).message };
  return input.raised > 0
    ? { outcome: "raised", error: missed }
    : { outcome: "quiet", error: null };
}

const logged = (type: string) => (error: unknown) =>
  console.error(
    JSON.stringify({
      type,
      error: error instanceof Error ? error.name : "UnknownError",
      timestamp: new Date().toISOString(),
    }),
  );

/** The apps a check-in reads, of those its Bot can read: all of them, the one it names, or none. */
function appsFor(
  setting: Pick<ProactiveSetting, "sourceKind" | "sourceServerId">,
  apps: CheckInApp[],
): CheckInApp[] {
  if (setting.sourceKind === "page") return [];
  if (setting.sourceKind === "app")
    return apps.filter((app) => app.serverId === setting.sourceServerId);
  return apps;
}

/**
 * Skips a person chose, or that pass by themselves: none of them says a check-in can't look, and
 * none breaks or extends a run of failures.
 */
const CHOSEN_SKIPS: ReadonlySet<string> = new Set([
  "off_admin",
  "off_person",
  "paused",
  "paused_all",
  "capped",
  "busy",
]);
/** How many failed check-ins in a row say a check-in can't look. */
const FAILURES_TO_FLAG = 3;
/** How long one person's answer about one Bot is kept for `health`, which the app polls. */
const LIVE_FOR_MS = 60_000;

/** What `health` asks afresh about one person and Bot, the gate's own questions. */
type Live = {
  canUse: boolean;
  /** Null when this deployment can't tell (no scope wired). */
  apps: CheckInApp[] | null;
  page: boolean | null;
  bot: string;
};

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
  /**
   * Which setting a run belongs to, for the run's own tools, and whether its turn got as far as
   * asking for them. Local: the turn runs in this process.
   */
  const running = new Map<
    string,
    {
      setting: ProactiveSetting;
      reached: boolean;
      catalogue: Catalogue;
      /** A page check-in's run: the tool its page was read with, which its items name as source. */
      pageRef?: string;
    }
  >();
  /**
   * The threads of page check-ins' turns while they run. Text from the open web never becomes
   * something a Bot learns about the person, so the turn runner answers no Learning container for
   * these (`learningContainerFor`).
   */
  const pageThreads = new Set<string>();

  /**
   * The deployment's apps, listed once for one check-in however many it names: each item raised,
   * each memory and each app it couldn't reach. A listing that failed is not kept, so the next name
   * asks again.
   */
  type Catalogue = () => ReturnType<
    ProactiveEngineDeps["catalogue"]["listServers"]
  >;
  function catalogueOnce(): Catalogue {
    let listed: ReturnType<Catalogue> | undefined;
    return () => {
      listed ??= deps.catalogue.listServers().catch((error: unknown) => {
        listed = undefined;
        throw error;
      });
      return listed;
    };
  }
  async function serverFor(catalogue: Catalogue, ref: string) {
    return (await catalogue()).find((server) =>
      server.tools.some((tool) => tool.ref === ref),
    );
  }
  /** The app a tool belongs to, by the name the person knows it by. */
  async function appOf(catalogue: Catalogue, ref: string) {
    return (await serverFor(catalogue, ref))?.title ?? ref.split("/")[0] ?? ref;
  }
  /**
   * The apps this run tried to read and could not: every call to them failed, and none answered.
   * One that answered once was reached, so a lookup that came back "not found" after a listing, or
   * a call that worked when the model tried it again, is not an app that was down.
   */
  async function unreached(
    reads: ProactiveRead[],
    runId: string,
    catalogue: Catalogue,
  ) {
    const serverOf = (ref: string) => ref.split("/")[0] ?? ref;
    const answered = new Set(reads.map((read) => serverOf(read.ref)));
    const failed = new Map<string, string>();
    for (const ref of await deps.store.failedReadsFor(runId))
      if (!answered.has(serverOf(ref)) && !failed.has(serverOf(ref)))
        failed.set(serverOf(ref), ref);
    return [
      ...new Set(
        await Promise.all(
          [...failed.values()].map((ref) => appOf(catalogue, ref)),
        ),
      ),
    ].sort();
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
    catalogue: Catalogue,
    pageRef?: string,
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
    const memory = deps.memory;
    const clear = tool(
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
    );
    /*
     * A page check-in's turn raises and clears, and nothing else: no memory (text from the open web
     * never becomes something a Bot knows about the person) and no tool that takes an address. What
     * it raises takes the page as its source; the model names no tool.
     */
    if (setting.sourceKind === "page" && pageRef && setting.sourceLink) {
      const link = setting.sourceLink;
      return [
        tool(
          "suggest_next_step",
          "Raise one next step for the person, from what changed on the page. They can start it as a task or hide it.",
          pageSuggestionInputSchema,
          async (input) => {
            if (
              (await deps.store.countSuggestions(runId)) >=
              MAX_SUGGESTIONS_PER_RUN
            )
              throw new ProactiveRefusedError(
                `This check-in already raised ${MAX_SUGGESTIONS_PER_RUN} next steps.`,
              );
            const row = await deps.store.raise(
              {
                ownerUserId: setting.ownerUserId,
                agentId: setting.agentId,
                settingId: setting.id,
                runId,
                title: input.title,
                detail: input.detail,
                sourceApp: pageHost(link),
                sourceRef: pageRef,
                sourceLink: link,
              },
              (prior) =>
                repeatOf(prior, {
                  ...input,
                  sourceLink: link,
                  agentId: setting.agentId,
                }),
            );
            return { suggested: row.id };
          },
        ),
        clear,
      ];
    }
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
          const sourceApp = await appOf(catalogue, read.ref);
          // Refused if any of the person's Bots already has it, checked and written under one lock.
          const row = await deps.store.raise(
            {
              ownerUserId: setting.ownerUserId,
              agentId: setting.agentId,
              settingId: setting.id,
              runId,
              title: input.title,
              detail: input.detail,
              sourceApp,
              sourceRef: read.ref,
              sourceLink: input.sourceLink ?? null,
            },
            (prior) => repeatOf(prior, { ...input, agentId: setting.agentId }),
          );
          return { suggested: row.id };
        },
      ),
      clear,
      ...(memory
        ? [
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
                const server = await serverFor(catalogue, read.ref);
                memories += 1;
                return memory.formMemory(setting.ownerUserId, {
                  agentId: setting.agentId,
                  content: input.content,
                  sourceApp:
                    server?.title ?? read.ref.split("/")[0] ?? read.ref,
                  sourceRef: read.ref,
                  ...(input.sourceLink ? { sourceLink: input.sourceLink } : {}),
                  observedAt: read.at,
                });
              },
            ),
          ]
        : []),
    ];
  }

  /** Offer a written ping to delivery, then record that it was. Delivery dedupes a second offer. */
  async function offer(ping: AttentionPing) {
    await deps.attention.notifyAttention(ping);
    await deps.store.pings.markOffered(ping.pingId);
  }

  /** Ping this person if their hour allows and something waits. */
  async function ping(ownerUserId: string) {
    const written = await deps.store.pings.take(ownerUserId);
    if (written) await offer(written);
    return written;
  }
  /**
   * The same, unless an admin turned check-ins off for them: that stops the pings too, not only the
   * runs.
   */
  async function tryPing(ownerUserId: string) {
    if (!(await allowed(ownerUserId))) return null;
    return ping(ownerUserId);
  }

  /**
   * The ping pass, every sweep: offer pings a stopped replica wrote but never offered, then ping
   * each person whose items waited for their hour to pass, up to {@link PINGS_PER_PASS} of them.
   * One person's failure is logged and the rest still go.
   *
   * IT PAGES PAST WHOEVER IT MAY NOT PING. A person an admin turned check-ins off for keeps the
   * items raised before the switch, oldest first in the queue, and is refused every pass. Taking
   * one page and stopping meant a page of them was all any pass ever saw, and nobody behind them was
   * pinged again. The admin's switch is resolved from roles and groups in code, so it is asked per
   * person here rather than written into the query; each person is asked once a pass.
   */
  async function pingPass() {
    for (const ping of await deps.store.pings.unoffered(UNOFFERED_AFTER_MS))
      await offer(ping).catch(logged("proactive-ping-error"));
    const tried: string[] = [];
    let pinged = 0;
    while (pinged < PINGS_PER_PASS) {
      const people = await deps.store.pings.waiting(PINGS_PER_PASS, tried);
      if (people.length === 0) return;
      for (const ownerUserId of people) {
        tried.push(ownerUserId);
        const may = await allowed(ownerUserId).catch((error: unknown) => {
          logged("proactive-ping-error")(error);
          return false;
        });
        if (!may) continue;
        pinged += 1;
        await ping(ownerUserId).catch(logged("proactive-ping-error"));
        if (pinged >= PINGS_PER_PASS) return;
      }
    }
  }

  /**
   * Why a check-in for this setting would find nothing, or the apps it can read when it may go to
   * the model. The gates, cheapest first, none of them a model call. Asked by the run itself, and by
   * Run now before it queues one, so the person hears at once why it can't.
   */
  async function gateOf(
    setting: ProactiveSetting,
  ): Promise<
    | { skip: ProactiveSkipReason }
    | { apps: CheckInApp[]; pageReader?: { ref: string; name: string } }
  > {
    if (await deps.store.personOff(setting.ownerUserId))
      return { skip: "off_person" };
    if (await deps.store.pausedAll(setting.ownerUserId))
      return { skip: "paused_all" };
    if (await deps.store.paused(setting.ownerUserId, setting.agentId))
      return { skip: "paused" };
    if (!(await allowed(setting.ownerUserId))) return { skip: "off_admin" };
    if (
      (await deps.store.runsToday(setting.ownerUserId, setting.agentId)) >=
      (await dailyRuns(setting.agentId))
    )
      return { skip: "capped" };
    if (!(await deps.canUseBot(setting.ownerUserId, setting.agentId)))
      return { skip: "unreachable" };
    // A page check-in reads its one address with the Bot's page-read tool, and nothing else.
    if (setting.sourceKind === "page") {
      const reader = await deps.pageReader?.(
        setting.ownerUserId,
        setting.agentId,
      );
      return reader ? { apps: [], pageReader: reader } : { skip: "no_sources" };
    }
    if (!deps.readableApps) return { apps: [] };
    // Nothing the person connected that this Bot can read: there is nothing for a check-in to find.
    const apps = appsFor(
      setting,
      await deps.readableApps(setting.ownerUserId, setting.agentId),
    );
    return apps.length === 0 ? { skip: "no_sources" } : { apps };
  }

  /**
   * What a new check-in reads, worked out on the server and refused, with the sentence the person
   * reads, when it could not look at all. From `readWith` (the tool the Bot read the thing with, sent
   * back by the offer card) when there is one, else from `watches` (New routine's It watches).
   */
  async function sourceFor(
    ownerUserId: string,
    agentId: string,
    asked: { readWith?: unknown; watches?: unknown; sourceLink?: unknown },
  ): Promise<{ kind: CheckInSourceKind; serverId: string | null }> {
    let kind: CheckInSourceKind = asked.watches === "page" ? "page" : "apps";
    let app: { serverId: string; title: string } | null = null;
    if (typeof asked.readWith === "string" && asked.readWith.trim()) {
      const source = deps.sourceOf
        ? await deps.sourceOf(ownerUserId, agentId, asked.readWith.trim())
        : null;
      if (source?.kind === "unreadable")
        throw new ProactiveRefusedError(
          `This Bot can't read ${source.title} as you. Connect ${source.title} first.`,
        );
      if (!source)
        throw new ProactiveRefusedError(
          "A check-in reads an app you connected or a public web page, and this Bot read that another way.",
        );
      kind = source.kind;
      if (source.kind === "app") app = source;
    }
    if (kind === "page") {
      if (
        typeof asked.sourceLink !== "string" ||
        !publicPageAddress(asked.sourceLink)
      )
        throw new ProactiveRefusedError(
          "Enter the page's address, starting with https://.",
        );
      if (!(await deps.pageReader?.(ownerUserId, agentId)))
        throw new ProactiveRefusedError(
          "This Bot has no web search, so it can't read a web page.",
        );
      return { kind, serverId: null };
    }
    if (!deps.readableApps) return { kind, serverId: app?.serverId ?? null };
    const apps = await deps.readableApps(ownerUserId, agentId);
    if (app) {
      const named = app;
      if (!apps.some((readable) => readable.serverId === named.serverId))
        throw new ProactiveRefusedError(
          `This Bot can't read ${named.title} as you. Connect ${named.title} first.`,
        );
      return { kind: "app", serverId: named.serverId };
    }
    if (apps.length === 0)
      throw new ProactiveRefusedError(
        "This Bot can't read any app you've connected. Connect one in Connections first.",
      );
    return { kind: "apps", serverId: null };
  }

  /** What `health` asks afresh, kept for a minute per person and Bot: the app polls it. */
  const live = new Map<string, { at: number; answer: Promise<Live> }>();
  function liveOf(ownerUserId: string, agentId: string): Promise<Live> {
    const key = `${ownerUserId}\u001f${agentId}`;
    const kept = live.get(key);
    if (kept && now().getTime() - kept.at < LIVE_FOR_MS) return kept.answer;
    const answer = (async (): Promise<Live> => {
      const [canUse, apps, reader, bot] = await Promise.all([
        deps.canUseBot(ownerUserId, agentId),
        deps.readableApps
          ? deps.readableApps(ownerUserId, agentId)
          : Promise.resolve(null),
        deps.pageReader
          ? deps.pageReader(ownerUserId, agentId)
          : Promise.resolve(undefined),
        deps.botName
          ? deps.botName(ownerUserId, agentId)
          : Promise.resolve(null),
      ]);
      return {
        canUse,
        apps,
        page: reader === undefined ? null : reader !== null,
        bot: bot ?? "This Bot",
      };
    })();
    answer.catch(() => live.delete(key));
    live.set(key, { at: now().getTime(), answer });
    return answer;
  }

  /** Whether a check-in that is on can't look, and what fixes it (`CheckInHealth`). */
  function healthOf(
    setting: ProactiveSetting,
    state: Live,
    runs: readonly ProactiveRunRow[],
    titleOf: (serverId: string) => string | undefined,
    serverOfTitle: (title: string) => string | undefined,
  ): CheckInHealth | null {
    if (!setting.enabled) return null;
    const bot = state.bot;
    // Asked afresh, with the gate's own questions, so the row clears the moment it is fixed.
    if (!state.canUse)
      return {
        why: "This Bot is no longer available to you.",
        fix: "remove",
        app: null,
      };
    if (setting.sourceKind === "apps" && state.apps?.length === 0)
      return {
        why: `${bot} can't read any app you've connected.`,
        fix: "connect",
        app: null,
      };
    if (setting.sourceKind === "app" && state.apps && setting.sourceServerId) {
      const serverId = setting.sourceServerId;
      if (!state.apps.some((app) => app.serverId === serverId)) {
        const title = titleOf(serverId) ?? serverId;
        return {
          why: `${title} isn't connected, so ${bot} can't check ${setting.subject || "it"}.`,
          fix: "connect",
          app: { serverId, title },
        };
      }
    }
    if (setting.sourceKind === "page" && state.page === false)
      return {
        why: `${bot} has no web search, so it can't read this page.`,
        fix: "connect",
        app: null,
      };
    // Three failures in a row, newest first; a skip the person chose neither breaks nor extends one.
    const counted = runs
      .filter(
        (run) =>
          run.outcome !== "running" &&
          !(
            run.outcome === "skipped" &&
            run.skipReason &&
            CHOSEN_SKIPS.has(run.skipReason)
          ),
      )
      .slice(0, FAILURES_TO_FLAG);
    if (
      counted.length < FAILURES_TO_FLAG ||
      !counted.every((run) => run.outcome === "failed")
    )
      return null;
    const unreached = counted
      .map((run) => unreachedApps(run.error) ?? [])
      .reduce((common, apps) => common.filter((app) => apps.includes(app)));
    const title = unreached[0];
    if (title) {
      const serverId =
        (setting.sourceKind === "app" ? setting.sourceServerId : null) ??
        serverOfTitle(title);
      return {
        why: `${bot} couldn't reach ${title} the last ${FAILURES_TO_FLAG} times.`,
        fix: "open",
        app: serverId ? { serverId, title } : null,
      };
    }
    return {
      why:
        setting.sourceKind === "page"
          ? `${bot} couldn't read this page the last ${FAILURES_TO_FLAG} times.`
          : `${bot} couldn't finish its last ${FAILURES_TO_FLAG} check-ins.`,
      fix: "open",
      app: null,
    };
  }

  /** A check-in a gate stopped, in the ledger with its reason, where the Bot's check-ins read it. */
  async function skip(
    setting: ProactiveSetting,
    runId: string,
    trigger: ProactiveRunTrigger,
    reason: ProactiveSkipReason,
  ) {
    if (reason === "unreachable")
      await deps.store.recordRun(
        setting.id,
        "error",
        "This Bot is no longer available to you, so it didn't check in.",
      );
    await deps.store.skipRun({ id: runId, setting, trigger, reason });
  }

  async function run(
    settingId: string,
    runId: string,
    trigger: ProactiveRunTrigger,
    signal: AbortSignal,
  ) {
    const setting = await deps.store.byId(settingId);
    if (!setting?.enabled) return;
    const gate = await gateOf(setting);
    if ("skip" in gate) return skip(setting, runId, trigger, gate.skip);
    // Read before this run is in the ledger, so the window opens at a check-in before it.
    const lastRead = await deps.store.windowStart(setting.id);
    const threadId = deps.mintThreadId();
    const admitted = await deps.store.beginRun({
      id: runId,
      setting,
      trigger,
      threadId,
      dailyLimit: await dailyRuns(setting.agentId),
    });
    if (admitted !== true)
      return skip(
        setting,
        runId,
        trigger,
        admitted === "capped" ? "capped" : "busy",
      );
    /*
     * FROM HERE THE RUN IS IN THE LEDGER AS RUNNING, and every step until it is closed can fail on
     * its own: a database call that drops its connection is enough. Left running, the row would make
     * the next scheduled check-in skip as busy, Run now say "This Bot is checking in now", and the
     * Bot's last status read running, until the lease sweep closed it ten minutes on. So whatever
     * stops it, it is closed as failed here, and its status recorded, before the error goes on.
     */
    let closed = false;
    let recorded = false;
    let status: "succeeded" | "error" = "error";
    let lastError: string | null = STOPPED_BEFORE_FINISHING;
    try {
      await deps.store.recordRun(setting.id, "running");
      if (setting.sourceKind === "page") {
        const result = await pageRun(
          setting,
          runId,
          trigger,
          threadId,
          gate.pageReader,
          signal,
        );
        await deps.store.finishRun(runId, result);
        closed = true;
        status = result.outcome === "failed" ? "error" : "succeeded";
        lastError = result.error;
        await deps.store.recordRun(setting.id, status, lastError);
        recorded = true;
        if (result.itemsRaised > 0)
          await tryPing(setting.ownerUserId).catch(
            logged("proactive-ping-error"),
          );
        return;
      }
      const prior = await deps.store.priorItems(
        setting.ownerUserId,
        setting.agentId,
      );
      const turn = { setting, reached: false, catalogue: catalogueOnce() };
      running.set(runId, turn);
      const instruction = researchInstruction(
        setting,
        checkInWindow(lastRead, now()),
        contextOf(prior, setting.agentId),
        trigger,
        gate.apps.map((app) => app.title),
        deps.memory !== undefined,
      );
      let thrown: unknown = null;
      try {
        await deps.runTurn({
          ownerUserId: setting.ownerUserId,
          routineId: `proactive:${setting.id}`,
          agentId: setting.agentId,
          // A fresh thread: an hourly check-in must not carry every earlier one, and their mail.
          threadId,
          instruction,
          /*
           * Its own message, as it is: a check-in is not a routine, and the runner puts a routine's
           * frame ("one of your routines is firing right now, on its schedule") around any instruction
           * that arrives without one. The instruction opens by saying what started it.
           */
          userMessage: {
            id: `check-in:${runId}`,
            role: "user",
            content: instruction,
          },
          initiator: proactiveInitiator(runId),
          runId,
          signal,
        });
      } catch (error) {
        thrown = error;
      } finally {
        running.delete(runId);
      }
      // Metered once its turn was admitted and went to the model, whether or not it then finished.
      if (turn.reached)
        await recordHeadlessUsage({
          ownerUserId: setting.ownerUserId,
          agentId: setting.agentId,
          threadId,
          runId,
        });
      const [raised, reads] = await Promise.all([
        deps.store.countSuggestions(runId),
        deps.store.readsFor(runId),
      ]);
      const { outcome, error } = outcomeOf({
        thrown,
        raised,
        reads: reads.length,
        unreached: await unreached(reads, runId, turn.catalogue),
      });
      await deps.store.finishRun(runId, {
        outcome,
        itemsRaised: raised,
        reads: reads.length,
        error,
      });
      closed = true;
      status = outcome === "failed" ? "error" : "succeeded";
      lastError = error;
      await deps.store.recordRun(setting.id, status, lastError);
      recorded = true;
      // Items recorded before a failure are still the person's, so they wait for a ping too.
      if (raised > 0)
        await tryPing(setting.ownerUserId).catch(
          logged("proactive-ping-error"),
        );
    } finally {
      if (!closed)
        await deps.store
          .finishRun(runId, {
            outcome: "failed",
            itemsRaised: await deps.store
              .countSuggestions(runId)
              .catch(() => 0),
            reads: 0,
            error: STOPPED_BEFORE_FINISHING,
          })
          .catch(logged("proactive-run-close-error"));
      if (!recorded)
        await deps.store
          .recordRun(setting.id, status, lastError)
          .catch(logged("proactive-run-close-error"));
    }
  }

  /**
   * One page check-in, after its gates: the engine reads the one address itself, and the model is
   * given the text, never a tool that takes an address.
   *
   * - The read failed: failed, "Couldn't read the page." Three in a row is can't look.
   * - First read: kept as the baseline, quiet. Nothing is raised about a page nobody saw change.
   * - Same as last time: quiet, and no model call.
   * - Changed: one turn with the earlier and the new text, whose only tools raise and clear. The new
   *   text becomes the baseline once that turn finished, so a turn that broke off is compared again.
   */
  async function pageRun(
    setting: ProactiveSetting,
    runId: string,
    trigger: ProactiveRunTrigger,
    threadId: string,
    reader: { ref: string; name: string } | undefined,
    signal: AbortSignal,
  ): Promise<{
    outcome: "quiet" | "raised" | "failed";
    itemsRaised: number;
    reads: number;
    error: string | null;
  }> {
    const link = setting.sourceLink;
    let text = "";
    try {
      if (!reader || !link || !deps.readPage) throw new Error(PAGE_UNREAD);
      text = normalisedPage(
        await deps.readPage({
          ownerUserId: setting.ownerUserId,
          agentId: setting.agentId,
          ref: reader.ref,
          link,
          initiator: proactiveInitiator(runId),
        }),
      );
    } catch {
      text = "";
    }
    if (!text || !reader)
      return {
        outcome: "failed",
        itemsRaised: 0,
        reads: 0,
        error: PAGE_UNREAD,
      };
    const hash = pageHashOf(text);
    const kept = await deps.store.keptPage(setting.id);
    if (!kept || kept.hash === hash) {
      await deps.store.keepPage(setting.id, text, hash);
      return { outcome: "quiet", itemsRaised: 0, reads: 1, error: null };
    }
    const prior = await deps.store.priorItems(
      setting.ownerUserId,
      setting.agentId,
    );
    const turn = {
      setting,
      reached: false,
      catalogue: catalogueOnce(),
      pageRef: reader.ref,
    };
    running.set(runId, turn);
    pageThreads.add(threadId);
    const instruction = pageInstruction(
      setting,
      { earlier: kept.text, now: text },
      contextOf(prior, setting.agentId),
      trigger,
    );
    let thrown: unknown = null;
    try {
      await deps.runTurn({
        ownerUserId: setting.ownerUserId,
        routineId: `proactive:${setting.id}`,
        agentId: setting.agentId,
        threadId,
        instruction,
        userMessage: {
          id: `check-in:${runId}`,
          role: "user",
          content: instruction,
        },
        initiator: proactiveInitiator(runId),
        runId,
        signal,
      });
    } catch (error) {
      thrown = error;
    } finally {
      running.delete(runId);
      pageThreads.delete(threadId);
    }
    if (turn.reached)
      await recordHeadlessUsage({
        ownerUserId: setting.ownerUserId,
        agentId: setting.agentId,
        threadId,
        runId,
      });
    const raised = await deps.store.countSuggestions(runId);
    if (thrown && !(thrown instanceof EmptyTurnError))
      return {
        outcome: "failed",
        itemsRaised: raised,
        reads: 1,
        error:
          thrown instanceof Error ? thrown.message : "The check-in failed.",
      };
    await deps.store.keepPage(setting.id, text, hash);
    return {
      outcome: raised > 0 ? "raised" : "quiet",
      itemsRaised: raised,
      reads: 1,
      error: null,
    };
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
    /** Whether this initiator is a page check-in's run, whose turn holds no granted tool. */
    isPageRun(initiator: AuditInitiator | null | undefined) {
      const runId = proactiveRunIdOf(initiator ?? undefined);
      return runId ? running.get(runId)?.pageRef !== undefined : false;
    },
    /** Whether a thread is a page check-in's turn, which no Learning container is given. */
    isPageThread(threadId: string) {
      return pageThreads.has(threadId);
    },
    /** The headless tools for one proactive turn; empty for any other initiator. */
    async toolsForTurn(input: {
      ownerUserId: string;
      agentId: string;
      initiator: AuditInitiator;
    }): Promise<HeadlessTool[]> {
      const runId = proactiveRunIdOf(input.initiator);
      const turn = runId ? running.get(runId) : undefined;
      const setting = turn?.setting;
      if (
        !runId ||
        !turn ||
        !setting ||
        setting.ownerUserId !== input.ownerUserId ||
        setting.agentId !== input.agentId
      )
        return [];
      // The runner asks for a turn's tools once it admitted the turn, just before the model.
      turn.reached = true;
      const own = toolsForRun(setting, runId, turn.catalogue, turn.pageRef);
      const ownNames = new Set(own.map((tool) => tool.definition.name));
      // A check-in on one app or one page is refused every other app's reads too.
      const others =
        setting.sourceKind === "apps"
          ? []
          : (
              (await deps.readableApps?.(input.ownerUserId, input.agentId)) ??
              []
            )
              .filter(
                (app) =>
                  !appsFor(setting, [app]).some(
                    (kept) => kept.serverId === app.serverId,
                  ),
              )
              .flatMap((app) => app.names);
      const denied = [
        ...((await deps.deniedToolNames?.(input.ownerUserId, input.agentId)) ??
          []),
        ...others,
      ].filter((name) => !ownNames.has(name));
      return [...own, ...refusalsFor([...new Set(denied)])];
    },
    /** `options` as the store takes them: `refuseExisting` for a caller that asked for a new one. */
    async create(
      ownerUserId: string,
      input: unknown,
      options: { refuseExisting?: boolean } = {},
    ) {
      const {
        readWith,
        watches,
        ...rest
      }: {
        readWith?: unknown;
        watches?: unknown;
        agentId?: unknown;
        sourceLink?: unknown;
      } = typeof input === "object" && input !== null ? input : {};
      if (
        typeof rest.agentId !== "string" ||
        !(await deps.canUseBot(ownerUserId, rest.agentId))
      )
        throw new ProactiveRefusedError("Choose one of your Bots.");
      // Refused here, with what to do, when it could not look at all.
      const source = await sourceFor(ownerUserId, rest.agentId, {
        readWith,
        watches,
        sourceLink: rest.sourceLink,
      });
      live.clear();
      return deps.store.create(ownerUserId, rest, deps.mintThreadId(), {
        ...options,
        source,
      });
    },
    /** `GET /api/proactive/readable`: what a check-in for this Bot could read, for New routine. */
    async readable(ownerUserId: string, agentId: string) {
      if (!(await deps.canUseBot(ownerUserId, agentId)))
        throw new ProactiveRefusedError("Choose one of your Bots.");
      const [apps, reader] = await Promise.all([
        deps.readableApps?.(ownerUserId, agentId) ?? [],
        deps.pageReader?.(ownerUserId, agentId) ?? null,
      ]);
      return { apps: apps.map((app) => app.title), page: reader !== null };
    },
    /**
     * For each of the person's check-ins: what it reads, as its row says it, and whether it can't
     * look (`CheckInHealth`). The questions the gate asks are asked afresh (kept a minute), so a row
     * clears the moment the app is connected; three failures clear when the next run finishes.
     */
    async describe(ownerUserId: string, settings: readonly ProactiveSetting[]) {
      const [recent, servers] = await Promise.all([
        deps.store.recentRuns(ownerUserId, 10),
        deps.catalogue.listServers().catch(() => []),
      ]);
      const titleOf = (serverId: string) =>
        servers.find((server) => server.id === serverId)?.title;
      const serverOfTitle = (title: string) =>
        servers.find((server) => server.title === title)?.id;
      const described = new Map<
        string,
        { reads: string | null; health: CheckInHealth | null }
      >();
      for (const setting of settings) {
        const reads =
          setting.sourceKind === "page"
            ? pageHost(setting.sourceLink)
            : setting.sourceKind === "app" && setting.sourceServerId
              ? (titleOf(setting.sourceServerId) ?? null)
              : "your apps";
        const health = setting.enabled
          ? healthOf(
              setting,
              await liveOf(ownerUserId, setting.agentId),
              recent.get(setting.id) ?? [],
              titleOf,
              serverOfTitle,
            )
          : null;
        described.set(setting.id, { reads, health });
      }
      return described;
    },
    /**
     * The check-in scope a proactive run's tools are offered from: a check-in on one app reads that
     * app alone, and one on a page reads no app (its page is read by the engine, not the model).
     * Every other initiator gets the scope as it is. A proactive run this process isn't running is
     * offered nothing.
     */
    scopeForRun(
      initiator: AuditInitiator | null | undefined,
      scope: CheckInScope,
    ): CheckInScope {
      const runId = proactiveRunIdOf(initiator ?? undefined);
      if (!runId) return scope;
      return async (ownerUserId, agentId) => {
        const setting = running.get(runId)?.setting;
        if (!setting || setting.sourceKind === "page") return new Map();
        const reads = await scope(ownerUserId, agentId);
        if (setting.sourceKind === "apps") return reads;
        return new Map(
          [...reads].filter(
            ([ref]) => serverOfRef(ref) === setting.sourceServerId,
          ),
        );
      };
    },
    /**
     * Check in now, because the person asked. Either it is queued, or they are told plainly why it
     * isn't, never a silent nothing:
     * - refused while one is running, or within ten minutes of one that reached the model;
     * - skipped at once, with its reason in the ledger and in the answer, when a gate would stop it
     *   anyway (nothing it can read, paused, turned off). A skip costs nothing, so it never starts
     *   the ten minutes and the next Run now is tried again.
     *
     * Pressed twice before it runs, it is queued once: the queue key names the setting's newest
     * check-in, so both presses offer the same key, and the next press after any check-in, skipped
     * or not, offers a new one.
     */
    async runNow(ownerUserId: string, id: string): Promise<RunNowResponse> {
      const setting = await deps.store.get(ownerUserId, id);
      if (!setting.enabled)
        throw new ProactiveRefusedError(
          "Turn on check-ins for this Bot first.",
        );
      const latest = await deps.store.latestRun(setting.id);
      if (latest?.outcome === "running")
        throw new ProactiveRefusedError("This Bot is checking in now.");
      const last = await deps.store.lastCheckIn(setting.id);
      const wait = last
        ? RUN_NOW_GAP_MS - (now().getTime() - last.startedAt.getTime())
        : 0;
      if (wait > 0) {
        const minutes = Math.ceil(wait / 60_000);
        throw new ProactiveRefusedError(
          `This Bot checked in less than ten minutes ago. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`,
        );
      }
      const runId = crypto.randomUUID();
      const gate = await gateOf(setting);
      if ("skip" in gate) {
        await skip(setting, runId, "run_now", gate.skip);
        return {
          queued: false,
          skipped: gate.skip,
          why: SKIPPED_BECAUSE[gate.skip],
        };
      }
      const payload = { settingId: setting.id, runId, trigger: "run_now" };
      const offered = await deps.queue.offer({
        kind: PROACTIVE_RUN_KIND,
        key: `${setting.id}:now:${latest?.id ?? "first"}`,
        payload,
      });
      /*
       * Already offered and already done: that Run now came up after check-ins were turned off and
       * ran nothing, so no newer check-in moved the key on. This one is new work under its own key.
       */
      if (offered === "already" && !(await deps.store.runQueued(setting.id)))
        await deps.queue.offer({
          kind: PROACTIVE_RUN_KIND,
          key: `${setting.id}:now:${runId}`,
          payload,
        });
      return { queued: true };
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
      if (!(await deps.canUseBot(ownerUserId, suggestion.agentId)))
        throw new ProactiveRefusedError(
          "This Bot is no longer available to you.",
        );
      /*
       * Refused up front while its Bot is paused, by itself or with all: no task is made. It used to
       * be made, and its turn then refused by the pause, leaving a task that never started.
       */
      if (await deps.store.pausedAll(ownerUserId))
        throw new ProactiveRefusedError(
          "Your Bots are paused. Resume them to work on this.",
        );
      if (await deps.store.paused(ownerUserId, suggestion.agentId))
        throw new ProactiveRefusedError(
          `${(await deps.botName?.(ownerUserId, suggestion.agentId)) ?? "This Bot"} is paused. Resume it to work on this.`,
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
