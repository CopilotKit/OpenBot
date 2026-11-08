/**
 * A conversation the server carries on after an approval, and the Stop that reaches it.
 *
 * When the person answers an approval, the run that asked has already ended in their browser, and
 * the approval resume loop runs the action and picks the conversation up in a headless turn of its
 * own (`resume-sweep.ts`). Their Stop on that conversation is a thread-wide stop on the runtime's
 * route, and the runtime's runner stops only runs it holds itself: the carried-on turn is held by
 * another runner instance (the one routines use), on whichever replica claimed the resume. So the
 * Stop answered "no active run", and the turn ran to the end with the Stop button on screen.
 *
 * So every carried-on turn runs here, under a signal kept by its thread for as long as it runs, and
 * a Stop that the runtime's own runner could not place is offered to it. A Stop can arrive at any
 * replica, so it is announced on {@link CARRIED_ON_STOP_TOPIC} and every replica stops the turn it
 * holds in that thread, this one included. Nothing is written: a turn is only ever running in the
 * process that runs it, and the announcement is a moment, like the busy signal.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import postgres from "postgres";
import type { Database } from "../db/client";
import { approvalRequests } from "../db/schema";

export const CARRIED_ON_STOP_TOPIC = "openbot_carried_on_stop";

export type CarriedOnTurns = {
  /**
   * Hold `threadId` stoppable from now until `release`: a Stop aborts `signal`.
   *
   * Held from the moment the resume loop claims the decision, not only once the turn starts. Between
   * the two the server runs the approved action, and a Stop pressed then must still keep the
   * conversation from being carried on afterwards; the action itself was approved and is not undone.
   */
  hold(threadId: string): { signal: AbortSignal; release: () => void };
  /**
   * Run one carried-on turn in `threadId`, stoppable by that thread until it returns.
   *
   * A Stop aborts the signal `turn` is given. The turn runner answers an aborted signal by stopping
   * the run and throwing; that is the person's own decision rather than a failure, so it is answered
   * with `stopped()` here instead of thrown, and the resume loop finishes the request rather than
   * trying it again.
   */
  run<T>(
    threadId: string,
    turn: (signal: AbortSignal) => Promise<T>,
    stopped: () => T,
  ): Promise<T>;
  /** Stop the carried-on turn this process runs in `threadId`. Whether there was one. */
  stopHere(threadId: string): boolean;
  /**
   * A person's Stop on `threadId`, wherever its carried-on turn runs: here, and announced to every
   * other replica. Whether a carried-on turn was stopped here or is on record as running somewhere.
   */
  stop(threadId: string): Promise<boolean>;
};

export function createCarriedOnTurns(
  deps: {
    /** Tell every replica, this one included, to stop its turn in this thread. */
    announce?: (threadId: string) => Promise<void>;
    /** Whether an approval in this thread is decided and not yet carried through to the end. */
    carryingOn?: (threadId: string) => Promise<boolean>;
  } = {},
): CarriedOnTurns {
  const running = new Map<string, Set<AbortController>>();

  const stopHere = (threadId: string) => {
    const controllers = running.get(threadId);
    if (!controllers || controllers.size === 0) return false;
    for (const controller of controllers)
      controller.abort(new Error("Stopped by the person."));
    return true;
  };

  const hold = (threadId: string) => {
    const controller = new AbortController();
    const controllers = running.get(threadId) ?? new Set();
    controllers.add(controller);
    running.set(threadId, controllers);
    return {
      signal: controller.signal,
      release: () => {
        controllers.delete(controller);
        if (controllers.size === 0 && running.get(threadId) === controllers)
          running.delete(threadId);
      },
    };
  };

  return {
    hold,
    async run(threadId, turn, stopped) {
      const held = hold(threadId);
      try {
        return await turn(held.signal);
      } catch (error) {
        if (held.signal.aborted) return stopped();
        throw error;
      } finally {
        held.release();
      }
    },
    stopHere,
    async stop(threadId) {
      const here = stopHere(threadId);
      if (!deps.announce) return here;
      await deps.announce(threadId);
      return here || ((await deps.carryingOn?.(threadId)) ?? false);
    },
  };
}

/** Announce a Stop to every replica, on the database every replica already shares. */
export function announceCarriedOnStop(database: Database) {
  return async (threadId: string) => {
    await database.execute(
      sql`select pg_notify(${CARRIED_ON_STOP_TOPIC}, ${threadId})`,
    );
  };
}

/**
 * Whether the server is carrying an approval in this thread through: decided, or started, and not
 * yet `completed`. The same rows the conversation reads to show the Bot working.
 */
export function carryingOnInThread(database: Database) {
  return async (threadId: string) => {
    const [row] = await database
      .select({ id: approvalRequests.id })
      .from(approvalRequests)
      .where(
        and(
          inArray(approvalRequests.status, ["approved", "denied", "consumed"]),
          eq(sql`${approvalRequests.action}->>'threadId'`, threadId),
        ),
      )
      .limit(1);
    return row !== undefined;
  };
}

/** The end of a reply, as much as is needed to tell a whole one from a half-written one. */
const REPLY_TAIL = 160;

const words = (text: string) => text.replace(/\s+/g, " ").trim();

/**
 * Whether a thread's stored messages hold this reply to its end.
 *
 * By the end of the reply, because a half-written reply holds its beginning too; read as the Bot's
 * words joined, because a reply the turn reports is the text of every message it said. Whitespace is
 * not compared: the store and the stream may break the same words differently.
 */
export function holdsReply(
  messages: readonly { role?: unknown; content?: unknown }[],
  replyText: string,
): boolean {
  const reply = words(replyText);
  if (!reply) return true;
  const said = words(
    messages
      .filter(
        (message) =>
          message.role === "assistant" && typeof message.content === "string",
      )
      .map((message) => message.content as string)
      .join(" "),
  );
  return said.includes(reply.slice(-REPLY_TAIL));
}

/**
 * Wait until the thread's stored history holds the reply, reading it again until it does or the
 * time runs out. Giving up is not a failure: the turn has finished either way, and telling the
 * channel late is better than never.
 */
export function waitForReplyInTranscript(deps: {
  read: (input: {
    ownerUserId: string;
    threadId: string;
  }) => Promise<readonly { role?: unknown; content?: unknown }[]>;
  everyMs?: number;
  forMs?: number;
}) {
  const everyMs = deps.everyMs ?? 250;
  const forMs = deps.forMs ?? 10_000;
  return async (input: {
    ownerUserId: string;
    threadId: string;
    replyText: string;
  }) => {
    const deadline = Date.now() + forMs;
    for (;;) {
      const messages = await deps.read(input).catch(() => null);
      if (messages && holdsReply(messages, input.replyText)) return;
      if (Date.now() + everyMs > deadline) return;
      await new Promise((resolve) => setTimeout(resolve, everyMs));
    }
  };
}

export type CarriedOnStopListener = { stop: () => Promise<void> };

/**
 * Stop this replica's carried-on turn when any replica announces a Stop for its thread.
 *
 * On its own connection, because `LISTEN` holds one for the life of the subscription: taken from the
 * pool, it would be a connection the rest of the server never gets back.
 */
export async function startCarriedOnStopListener(
  databaseUrl: string,
  turns: Pick<CarriedOnTurns, "stopHere">,
): Promise<CarriedOnStopListener> {
  const connection = postgres(databaseUrl, { max: 1 });
  await connection.listen(CARRIED_ON_STOP_TOPIC, (threadId) => {
    turns.stopHere(threadId);
  });
  return {
    stop: async () => {
      await connection.end();
    },
  };
}
