import { AsyncLocalStorage } from "node:async_hooks";
import PQueue from "p-queue";

/**
 * One run's calls to its apps: a few at a time, and a read asked twice answered once.
 *
 * FOUND LIVE. A Bot planning a cycle sent 20 lookups at once to two apps. An app meets a burst like
 * that the way apps do, with timeouts and 429s for its tail, and the Bot planned for that burst
 * because nothing told it otherwise. Leading agent products run three to five at a time for this
 * reason (Cursor's prompt says so), and Claude Code queues past ten.
 *
 * WHAT THIS DOES, per run: at most {@link MAX_APP_CALLS_AT_ONCE} app calls are out at once and the
 * rest wait their turn, in the order they were asked for, so the model still sends its batch and
 * every call still gets its own answer. And a read with the same tool and the same arguments as one
 * already answered in this run gets that answer back, marked as such, instead of a second trip to
 * the app: models re-ask for what they already hold, and the note tells this one it does.
 *
 * ONE PER RUN, BECAUSE A RUN IS WHAT IT IS ABOUT. A new message starts a run with nothing cached,
 * so a person asking "check again" gets a fresh read, and nothing outlives the run to go stale.
 */

/** How many of one run's app calls are out at once. */
export const MAX_APP_CALLS_AT_ONCE = 5;

/** What a read answered from earlier in the run says above the answer. */
export const ALREADY_FETCHED =
  "Already fetched earlier in this run with these same arguments, so this is that result again rather than a new read. Use it; there is no need to ask for it again.";

/** What one app call came back with, and whether it is an answer worth giving again. */
export type AppCallAnswer = { text: string; reusable: boolean };

export type RunCalls = {
  /**
   * Make one app call in its turn. A read with `key` set is answered from this run's earlier answer
   * to the same key where there is one; a call without a key (a write) always goes to the app.
   */
  call(key: string | null, make: () => Promise<AppCallAnswer>): Promise<string>;
};

/** Arguments as one string, the same whatever order their keys were written in. */
export function sameArguments(args: unknown): string {
  return JSON.stringify(args, (_key, value: unknown) =>
    value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(
          Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
            a < b ? -1 : a > b ? 1 : 0,
          ),
        )
      : value,
  );
}

export function runCalls(limit: number = MAX_APP_CALLS_AT_ONCE): RunCalls {
  const queue = new PQueue({ concurrency: limit });
  /** Reads asked for in this run, by key: answered, or still on their way. */
  const reads = new Map<string, Promise<AppCallAnswer>>();
  const inTurn = (make: () => Promise<AppCallAnswer>) =>
    queue.add(make) as Promise<AppCallAnswer>;

  return {
    async call(key, make) {
      if (key === null) return (await inTurn(make)).text;
      /*
       * The same read already asked for: its answer, once it is in. One still on its way is waited
       * for rather than sent twice, which is the burst case: a model asking for the same page twice
       * in one batch. An earlier answer that is not worth giving again (an error, a refusal) leaves
       * this call to go to the app itself.
       */
      const earlier = reads.get(key);
      if (earlier) {
        const answered = await earlier.catch(() => null);
        if (answered?.reusable) return `${ALREADY_FETCHED}\n\n${answered.text}`;
      }
      const asked = inTurn(make);
      reads.set(key, asked);
      try {
        const answered = await asked;
        if (!answered.reusable && reads.get(key) === asked) reads.delete(key);
        return answered.text;
      } catch (error) {
        if (reads.get(key) === asked) reads.delete(key);
        throw error;
      }
    },
  };
}

/**
 * The app calls of the run a Bot is being built inside, when it is built inside one.
 *
 * A SUBAGENT IS PART OF ITS RUN, NOT A RUN OF ITS OWN. It is the same Bot built afresh from inside
 * the run's `run_subagent` call (`agents/subagent.ts`), so without this each subagent got its own
 * {@link MAX_APP_CALLS_AT_ONCE}, and a Bot that split a cycle plan in two had nine lookups out at
 * once against the same two apps (found live). Built inside {@link withAppCallsOf}, a Bot takes the
 * run's calls instead: one queue, and a read one subagent made is answered again for the other.
 */
const enclosing = new AsyncLocalStorage<RunCalls>();

/** This run's app calls: the enclosing run's when there is one, otherwise a new set. */
export function appCallsOfRun(): RunCalls {
  return enclosing.getStore() ?? runCalls();
}

/** Run `work` (a Bot's build, or a tool call that builds one) as part of the run holding `calls`. */
export function withAppCallsOf<T>(calls: RunCalls, work: () => T): T {
  return enclosing.run(calls, work);
}
