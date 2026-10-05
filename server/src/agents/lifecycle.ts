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
 */
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { botLifecycle, updateRoutingPreferences } from "../db/schema/lifecycle";

/** The sentence every skipped dispatch records, so the trail and the run rows say the same thing. */
export const BOT_PAUSED_REASON = "The Bot is paused, so it did not run.";

export class BotPausedError extends Error {
  override name = "BotPausedError";
  constructor() {
    super(BOT_PAUSED_REASON);
  }
}

export type BotNotify = "all" | "needs_input" | "none";
export type UpdateKind = "progress" | "decision" | "question";
export type UpdateTransport = "slack" | "teams" | "sms" | "push";
export const UPDATE_KINDS: readonly UpdateKind[] = [
  "progress",
  "decision",
  "question",
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
 * person and Bot. Three checks is fifteen seconds of a database that stays unreadable.
 */
const UNREADABLE_CHECKS_BEFORE_STOP = 3;

const state: {
  database?: Database;
  running: Map<string, Set<RunningTurn>>;
  /** Consecutive failed pause reads per pair, reset by the next read that answers. */
  unreadable: Map<string, number>;
  watcher?: ReturnType<typeof setInterval>;
} = { running: new Map(), unreadable: new Map() };

const keyOf = (ownerUserId: string, agentId: string) =>
  JSON.stringify([ownerUserId, agentId]);

/** Wire the pause switch to the deployment's database. Called once at start-up. */
export function configureBotLifecycle(options: { database: Database }) {
  state.database = options.database;
}

/** For tests: run the cross-replica check now instead of waiting for its interval. */
export const checkRunningTurnsForTests = () => checkRunningTurns();

/** For tests: forget the wiring and every tracked turn. */
export function resetBotLifecycleForTests() {
  state.database = undefined;
  state.running.clear();
  state.unreadable.clear();
  if (state.watcher) clearInterval(state.watcher);
  state.watcher = undefined;
}

/** Whether this person has paused this Bot, or `undefined` when the read failed (and is logged). */
async function readPause(
  database: Database,
  ownerUserId: string,
  agentId: string,
): Promise<boolean | undefined> {
  try {
    const [row] = await database
      .select({ pausedAt: botLifecycle.pausedAt })
      .from(botLifecycle)
      .where(
        and(
          eq(botLifecycle.ownerUserId, ownerUserId),
          eq(botLifecycle.agentId, agentId),
        ),
      )
      .limit(1);
    return Boolean(row?.pausedAt);
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
  const database = state.database;
  if (!database) return false;
  return (await readPause(database, ownerUserId, agentId)) ?? true;
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
  const database = state.database;
  if (!database) return;
  for (const key of [...state.running.keys()]) {
    const [ownerUserId, agentId] = JSON.parse(key) as [string, string];
    const paused = await readPause(database, ownerUserId, agentId);
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

export type BotLifecycleState = {
  agentId: string;
  paused: boolean;
  pausedAt: Date | null;
  notify: BotNotify;
};

export type BotLifecycleStore = ReturnType<typeof createBotLifecycleStore>;

/** The per-person rows, read and written. Authorization (may this person reach the Bot) is the caller's. */
export function createBotLifecycleStore(database: Database) {
  const upsert = (
    ownerUserId: string,
    agentId: string,
    values: { pausedAt?: Date | null; notify?: BotNotify },
  ) =>
    database
      .insert(botLifecycle)
      .values({ ownerUserId, agentId, ...values })
      .onConflictDoUpdate({
        target: [botLifecycle.ownerUserId, botLifecycle.agentId],
        set: { ...values, updatedAt: sql`now()` },
      });

  return {
    async get(
      ownerUserId: string,
      agentId: string,
    ): Promise<BotLifecycleState> {
      const [row] = await database
        .select()
        .from(botLifecycle)
        .where(
          and(
            eq(botLifecycle.ownerUserId, ownerUserId),
            eq(botLifecycle.agentId, agentId),
          ),
        )
        .limit(1);
      return {
        agentId,
        paused: Boolean(row?.pausedAt),
        pausedAt: row?.pausedAt ?? null,
        notify: row?.notify ?? "all",
      };
    },

    /** Every Bot this person has paused, for the roster's badges. */
    async pausedFor(ownerUserId: string): Promise<string[]> {
      const rows = await database
        .select({ agentId: botLifecycle.agentId })
        .from(botLifecycle)
        .where(
          and(
            eq(botLifecycle.ownerUserId, ownerUserId),
            isNotNull(botLifecycle.pausedAt),
          ),
        );
      return rows.map((row) => row.agentId);
    },

    async notifyFor(
      ownerUserId: string,
      agentIds: string[],
    ): Promise<Record<string, BotNotify>> {
      if (agentIds.length === 0) return {};
      const rows = await database
        .select({ agentId: botLifecycle.agentId, notify: botLifecycle.notify })
        .from(botLifecycle)
        .where(
          and(
            eq(botLifecycle.ownerUserId, ownerUserId),
            inArray(botLifecycle.agentId, agentIds),
          ),
        );
      return Object.fromEntries(rows.map((row) => [row.agentId, row.notify]));
    },

    /**
     * Pause, and stop what this replica is running for the pair right now. Other replicas stop
     * theirs on their next check. Returns how many running turns were stopped here.
     */
    async pause(ownerUserId: string, agentId: string): Promise<number> {
      await upsert(ownerUserId, agentId, { pausedAt: new Date() });
      return stopRunningTurns(keyOf(ownerUserId, agentId));
    },

    async resume(ownerUserId: string, agentId: string): Promise<void> {
      await upsert(ownerUserId, agentId, { pausedAt: null });
    },

    async setNotify(
      ownerUserId: string,
      agentId: string,
      notify: BotNotify,
    ): Promise<void> {
      await upsert(ownerUserId, agentId, { notify });
    },

    /** Where each kind of update goes. A kind with no row goes everywhere the person is reachable. */
    async routing(
      ownerUserId: string,
    ): Promise<Record<UpdateKind, UpdateTransport[] | "all">> {
      const rows = await database
        .select()
        .from(updateRoutingPreferences)
        .where(eq(updateRoutingPreferences.ownerUserId, ownerUserId));
      const byKind = new Map(rows.map((row) => [row.kind, row.transports]));
      return Object.fromEntries(
        UPDATE_KINDS.map((kind) => [kind, byKind.get(kind) ?? "all"]),
      ) as Record<UpdateKind, UpdateTransport[] | "all">;
    },

    async setRouting(
      ownerUserId: string,
      kind: UpdateKind,
      transports: UpdateTransport[] | "all",
    ): Promise<void> {
      if (transports === "all") {
        await database
          .delete(updateRoutingPreferences)
          .where(
            and(
              eq(updateRoutingPreferences.ownerUserId, ownerUserId),
              eq(updateRoutingPreferences.kind, kind),
            ),
          );
        return;
      }
      const unique = [...new Set(transports)];
      await database
        .insert(updateRoutingPreferences)
        .values({ ownerUserId, kind, transports: unique })
        .onConflictDoUpdate({
          target: [
            updateRoutingPreferences.ownerUserId,
            updateRoutingPreferences.kind,
          ],
          set: { transports: unique, updatedAt: sql`now()` },
        });
    },
  };
}

/** What the delivery router calls its three kinds, as the update kinds a person routes. */
const KIND_OF_DELIVERY: Record<"reply" | "question" | "approval", UpdateKind> =
  {
    reply: "progress",
    approval: "decision",
    question: "question",
  };

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
export async function resolveUpdateRoute(input: {
  ownerUserId: string;
  agentId: string;
  kind: "reply" | "question" | "approval";
}): Promise<UpdateRoute> {
  const kind = KIND_OF_DELIVERY[input.kind];
  const everything: UpdateRoute = { kind, notify: true, allows: () => true };
  const database = state.database;
  if (!database) return everything;
  try {
    const store = createBotLifecycleStore(database);
    const [lifecycle, routing] = await Promise.all([
      store.get(input.ownerUserId, input.agentId),
      store.routing(input.ownerUserId),
    ]);
    const notify =
      lifecycle.notify === "all" ||
      (lifecycle.notify === "needs_input" && kind !== "progress");
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
