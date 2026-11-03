/**
 * A Bot's lifecycle as one person runs it: pause and resume, reset, how loudly it may reach them,
 * and where each kind of update goes.
 *
 * PAUSE IS ENFORCED WHERE WORK STARTS, not where it is requested. Every place that starts a Bot's
 * turn without a person typing — a routine firing, a responsibility's event, a hop from another Bot,
 * a follow-up the Bot scheduled for itself, every headless turn — asks {@link isBotPaused} (or
 * {@link guardBotTurn}, which also makes the turn stoppable) immediately before it starts. A queue
 * that was filled before the pause therefore drains into skips rather than into turns.
 *
 * FAILS CLOSED. When the deployment has wired this module and the question cannot be answered, the
 * answer is "paused": a Bot that might have been stopped must not be started on a guess.
 *
 * A process that never wired it (a unit test of some other module) answers "not paused", because
 * there is nobody who could have paused anything.
 *
 * WHERE IT IS KEPT. A person's pauses, notification levels and routing are their preferences in
 * Intelligence, held in memory on every instance (configuration/directory.ts). So the question every
 * dispatch asks is answered from memory, and a pause made on another replica arrives with its
 * announcement; the watcher below then stops what is running here.
 */
import { type AnyColumn, type SQL, sql } from "drizzle-orm";
import {
  botConfiguration,
  botConfigurationInstalled,
} from "../configuration/directory";
import type { PersonBotPreference } from "../configuration/types";

/** The sentence every skipped dispatch records, so the trail and the run rows say the same thing. */
export const BOT_PAUSED_REASON = "The Bot is paused, so it did not run.";

export class BotPausedError extends Error {
  override name = "BotPausedError";
  constructor() {
    super(BOT_PAUSED_REASON);
  }
}

export type BotNotify = "all" | "needs_input" | "none";
/**
 * The kinds of update a person routes. `attention` is a ping: what their Bots' check-ins found that
 * needs them, at most once an hour, every Bot in one message ("Something needs you").
 */
export type UpdateKind = "progress" | "decision" | "question" | "attention";
export type UpdateTransport = "slack" | "teams" | "sms" | "push";
export const UPDATE_KINDS: readonly UpdateKind[] = [
  "progress",
  "decision",
  "question",
  "attention",
];
export const UPDATE_TRANSPORTS: readonly UpdateTransport[] = [
  "slack",
  "teams",
  "sms",
  "push",
];

type RunningTurn = { controller: AbortController; startedAt: number };

/**
 * How long a turn registered by {@link guardBotTurn} is kept after it started.
 *
 * The turn runner never reports that it finished (the guard is one line at its top), so entries are
 * dropped by age: twice the longest a headless turn may run. Aborting one that already finished is
 * harmless, so erring long costs nothing but a map entry.
 */
const TURN_RETENTION_MS = 10 * 60_000;
/** How often running turns are checked against pauses made on other replicas. */
const CROSS_REPLICA_CHECK_MS = 5_000;
/**
 * How many checks in a row may fail before the watcher stops a pair's turns. A turn never STARTS
 * on an unreadable pause, but one slow query must not stop every turn on the replica, for every
 * person and Bot. Three checks is fifteen seconds of pauses that stay unreadable.
 */
const UNREADABLE_CHECKS_BEFORE_STOP = 3;

/**
 * Where pauses are read. `pausedAt` answers null for a running Bot, the time it was paused, or
 * `undefined` when it cannot say (the preferences have not been read yet), which counts as paused.
 */
export type PauseReader = {
  pausedAt(ownerUserId: string, agentId: string): Date | null | undefined;
};

/** The pauses the Bot configuration holds, once it has been read. */
export const configuredPauses: PauseReader = {
  pausedAt(ownerUserId, agentId) {
    if (!botConfigurationInstalled()) return undefined;
    const configuration = botConfiguration();
    if (!configuration.preferences.loaded()) return undefined;
    return (
      configuration
        .preferencesOf(ownerUserId)
        .bots.find((entry) => entry.botId === agentId)?.pausedAt ?? null
    );
  },
};

const state: {
  pauses?: PauseReader;
  running: Map<string, Set<RunningTurn>>;
  /** Consecutive failed pause reads per pair, reset by the next read that answers. */
  unreadable: Map<string, number>;
  watcher?: ReturnType<typeof setInterval>;
} = { running: new Map(), unreadable: new Map() };

const keyOf = (ownerUserId: string, agentId: string) =>
  JSON.stringify([ownerUserId, agentId]);

/** Wire the pause switch to where pauses are kept. Called once at start-up. */
export function configureBotLifecycle(options: { pauses: PauseReader }) {
  state.pauses = options.pauses;
}

/** For tests: run the cross-replica check now instead of waiting for its interval. */
export const checkRunningTurnsForTests = () => checkRunningTurns();

/** For tests: forget the wiring and every tracked turn. */
export function resetBotLifecycleForTests() {
  state.pauses = undefined;
  state.running.clear();
  state.unreadable.clear();
  if (state.watcher) clearInterval(state.watcher);
  state.watcher = undefined;
}

/** Whether this person has paused this Bot, or `undefined` when it cannot be said (and is logged). */
function readPause(
  pauses: PauseReader,
  ownerUserId: string,
  agentId: string,
): boolean | undefined {
  try {
    const pausedAt = pauses.pausedAt(ownerUserId, agentId);
    if (pausedAt === undefined) {
      console.error(
        JSON.stringify({
          type: "bot-pause-check-failed",
          agentId,
          error: "This instance has not read people's preferences yet.",
        }),
      );
      return undefined;
    }
    return pausedAt !== null;
  } catch (error) {
    console.error(
      JSON.stringify({
        type: "bot-pause-check-failed",
        agentId,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    return undefined;
  }
}

/**
 * Whether this person has paused this Bot.
 *
 * Fails closed once wired: a read that throws answers `true` and says why in the log.
 */
export async function isBotPaused(
  ownerUserId: string,
  agentId: string,
): Promise<boolean> {
  const pauses = state.pauses;
  if (!pauses) return false;
  return readPause(pauses, ownerUserId, agentId) ?? true;
}

/**
 * The guard at the top of a headless turn: refuse if paused, otherwise hand back a signal that
 * aborts when this person pauses the Bot, on this replica at once and on any other within seconds.
 */
export async function guardBotTurn(input: {
  ownerUserId: string;
  agentId: string;
  signal?: AbortSignal;
}): Promise<AbortSignal> {
  if (await isBotPaused(input.ownerUserId, input.agentId))
    throw new BotPausedError();
  const controller = new AbortController();
  const key = keyOf(input.ownerUserId, input.agentId);
  const now = Date.now();
  const turns = state.running.get(key) ?? new Set<RunningTurn>();
  for (const turn of turns)
    if (now - turn.startedAt > TURN_RETENTION_MS) turns.delete(turn);
  turns.add({ controller, startedAt: now });
  state.running.set(key, turns);
  startWatcher();
  return input.signal
    ? AbortSignal.any([input.signal, controller.signal])
    : controller.signal;
}

/** Stop every turn this replica is running for this person and Bot. Returns how many. */
function stopRunningTurns(key: string): number {
  const turns = state.running.get(key);
  if (!turns) return 0;
  let stopped = 0;
  for (const turn of turns) {
    if (Date.now() - turn.startedAt <= TURN_RETENTION_MS) stopped += 1;
    turn.controller.abort(new BotPausedError());
  }
  state.running.delete(key);
  state.unreadable.delete(key);
  return stopped;
}

/**
 * Pauses made on another replica reach the turns running here through this poll.
 *
 * Only while something is being tracked, and unref'd, so an idle process pays nothing and a
 * one-shot process is never held open by it.
 */
function startWatcher() {
  if (state.watcher) return;
  state.watcher = setInterval(() => {
    void checkRunningTurns();
  }, CROSS_REPLICA_CHECK_MS);
  state.watcher.unref?.();
}

async function checkRunningTurns() {
  const now = Date.now();
  for (const [key, turns] of state.running) {
    for (const turn of turns)
      if (now - turn.startedAt > TURN_RETENTION_MS) turns.delete(turn);
    if (turns.size === 0) {
      state.running.delete(key);
      state.unreadable.delete(key);
    }
  }
  if (state.running.size === 0) {
    if (state.watcher) clearInterval(state.watcher);
    state.watcher = undefined;
    return;
  }
  const pauses = state.pauses;
  if (!pauses) return;
  for (const key of [...state.running.keys()]) {
    const [ownerUserId, agentId] = JSON.parse(key) as [string, string];
    const paused = readPause(pauses, ownerUserId, agentId);
    if (paused === undefined) {
      const failures = (state.unreadable.get(key) ?? 0) + 1;
      state.unreadable.set(key, failures);
      if (failures >= UNREADABLE_CHECKS_BEFORE_STOP) stopRunningTurns(key);
      continue;
    }
    state.unreadable.delete(key);
    if (paused) stopRunningTurns(key);
  }
}

/**
 * Every (person, Bot) pair whose setting passes `test`, from the preferences this instance holds.
 * Empty before they have been read: the pause each run checks again before it starts still fails
 * closed then.
 */
export function lifecyclePairs(
  test: (entry: PersonBotPreference) => boolean,
): { ownerUserId: string; agentId: string }[] {
  if (!botConfigurationInstalled()) return [];
  const configuration = botConfiguration();
  return configuration.preferences
    .all()
    .flatMap((record) =>
      record.bots
        .filter(test)
        .map((entry) => ({ ownerUserId: record.userId, agentId: entry.botId })),
    );
}

/**
 * A SQL condition true for rows whose (person, Bot) is NOT one of `pairs`: how a query in this
 * deployment's database leaves out what a person paused or silenced, now that the setting lives in
 * Intelligence and the query cannot join it.
 */
export function notAmongPairs(
  ownerColumn: AnyColumn,
  agentColumn: AnyColumn,
  pairs: readonly { ownerUserId: string; agentId: string }[],
): SQL {
  if (pairs.length === 0) return sql`true`;
  return sql`(${ownerColumn} || chr(31) || ${agentColumn}) <> ALL(ARRAY[${sql.join(
    pairs.map((pair) => sql`${`${pair.ownerUserId}\u001f${pair.agentId}`}`),
    sql`, `,
  )}]::text[])`;
}

export type BotLifecycleState = {
  agentId: string;
  paused: boolean;
  pausedAt: Date | null;
  notify: BotNotify;
};

export type BotLifecycleStore = ReturnType<typeof createBotLifecycleStore>;

/**
 * One person's settings for their Bots, read from the Bot configuration this instance holds and
 * written to Intelligence. Authorization (may this person reach the Bot) is the caller's.
 */
export function createBotLifecycleStore() {
  const entryOf = (ownerUserId: string, agentId: string) =>
    botConfiguration()
      .preferencesOf(ownerUserId)
      .bots.find((entry) => entry.botId === agentId);

  const setBot = (
    ownerUserId: string,
    agentId: string,
    values: { pausedAt?: Date | null; notify?: BotNotify },
  ) =>
    botConfiguration().changePreferences(ownerUserId, [
      { op: "setBot", botId: agentId, ...values },
    ]);

  return {
    async get(
      ownerUserId: string,
      agentId: string,
    ): Promise<BotLifecycleState> {
      const entry = entryOf(ownerUserId, agentId);
      return {
        agentId,
        paused: Boolean(entry?.pausedAt),
        pausedAt: entry?.pausedAt ?? null,
        notify: entry?.notify ?? "all",
      };
    },

    /** Every Bot this person has paused, for the roster's badges. */
    async pausedFor(ownerUserId: string): Promise<string[]> {
      return botConfiguration()
        .preferencesOf(ownerUserId)
        .bots.filter((entry) => entry.pausedAt !== null)
        .map((entry) => entry.botId);
    },

    async notifyFor(
      ownerUserId: string,
      agentIds: string[],
    ): Promise<Record<string, BotNotify>> {
      if (agentIds.length === 0) return {};
      const wanted = new Set(agentIds);
      return Object.fromEntries(
        botConfiguration()
          .preferencesOf(ownerUserId)
          .bots.filter((entry) => wanted.has(entry.botId))
          .map((entry) => [entry.botId, entry.notify]),
      );
    },

    /**
     * Pause, and stop what this replica is running for the pair right now. Other replicas stop
     * theirs once the change reaches them. Returns how many running turns were stopped here.
     */
    async pause(ownerUserId: string, agentId: string): Promise<number> {
      await setBot(ownerUserId, agentId, { pausedAt: new Date() });
      return stopRunningTurns(keyOf(ownerUserId, agentId));
    },

    async resume(ownerUserId: string, agentId: string): Promise<void> {
      await setBot(ownerUserId, agentId, { pausedAt: null });
    },

    async setNotify(
      ownerUserId: string,
      agentId: string,
      notify: BotNotify,
    ): Promise<void> {
      await setBot(ownerUserId, agentId, { notify });
    },

    /** Where each kind of update goes. A kind with no route goes everywhere the person is reachable. */
    async routing(
      ownerUserId: string,
    ): Promise<Record<UpdateKind, UpdateTransport[] | "all">> {
      const byKind = new Map(
        botConfiguration()
          .preferencesOf(ownerUserId)
          .routes.map((route) => [
            route.kind,
            route.transports as UpdateTransport[],
          ]),
      );
      return Object.fromEntries(
        UPDATE_KINDS.map((kind) => [kind, byKind.get(kind) ?? "all"]),
      ) as Record<UpdateKind, UpdateTransport[] | "all">;
    },

    async setRouting(
      ownerUserId: string,
      kind: UpdateKind,
      transports: UpdateTransport[] | "all",
    ): Promise<void> {
      await botConfiguration().changePreferences(ownerUserId, [
        {
          op: "setRoute",
          kind,
          transports: transports === "all" ? null : [...new Set(transports)],
        },
      ]);
    },
  };
}

/** What the delivery router calls its kinds, as the update kinds a person routes. */
const KIND_OF_DELIVERY: Record<
  "reply" | "question" | "approval" | "attention",
  UpdateKind
> = {
  reply: "progress",
  approval: "decision",
  question: "question",
  attention: "attention",
};

/**
 * What a delivery asks the route for. One Bot's reply, question or approval names that Bot. So does
 * a ping's chat message: it is posted in one Bot's conversation, as that Bot, so a Bot the person
 * told to notify them of nothing must not carry it. A ping's push names none: it folds several Bots'
 * items, and each Bot's notification preference was applied to its own items before the ping was
 * written (a Bot set to notify nothing contributes no item to one, see proactive/ping.ts), so only
 * the person's routing is left to decide it.
 */
export type UpdateRouteInput =
  | {
      ownerUserId: string;
      agentId: string;
      kind: "reply" | "question" | "approval";
    }
  | { ownerUserId: string; agentId?: string; kind: "attention" };

export type UpdateRoute = {
  /** Which update kind this delivery is, as the person's preferences name it. */
  kind: UpdateKind;
  /** Whether this delivery may leave the web at all (the per-Bot notification preference). */
  notify: boolean;
  /** Whether a transport may carry this delivery. Call once per binding or device. */
  allows: (transport: UpdateTransport) => boolean;
};

/**
 * The one lookup the delivery router consults before offering an outbox row.
 *
 * Combines the per-Bot notification preference (`none` sends nothing, `needs_input` sends
 * questions and approvals only) with the person's routing by kind. The web inbox and the sidebar
 * badges are not governed by this: they always show everything.
 *
 * FAILS OPEN TO THE DEFAULT, deliberately, and only here: a notification is a courtesy about work
 * that already happened, and a read that fails must not silently swallow a question somebody is
 * waiting to be asked. Unwired, it allows everything, which is the behaviour before this existed.
 */
export async function resolveUpdateRoute(
  input: UpdateRouteInput,
): Promise<UpdateRoute> {
  const kind = KIND_OF_DELIVERY[input.kind];
  const everything: UpdateRoute = { kind, notify: true, allows: () => true };
  if (!state.pauses || !botConfigurationInstalled()) return everything;
  try {
    const store = createBotLifecycleStore();
    const [level, routing] = await Promise.all([
      input.agentId
        ? store.get(input.ownerUserId, input.agentId).then((row) => row.notify)
        : Promise.resolve<BotNotify>("all"),
      store.routing(input.ownerUserId),
    ]);
    const notify =
      level === "all" || (level === "needs_input" && kind !== "progress");
    const transports = routing[kind];
    return {
      kind,
      notify,
      allows: (transport) =>
        notify && (transports === "all" || transports.includes(transport)),
    };
  } catch (error) {
    console.error(
      JSON.stringify({
        type: "update-route-lookup-failed",
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    return everything;
  }
}
