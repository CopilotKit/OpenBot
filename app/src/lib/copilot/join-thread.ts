/**
 * Joining a channel's durable thread, bounded, and OVER when it says it is over.
 *
 * THE DEADLINE ENDS THE CONNECT RATHER THAN OUTRUNNING IT: one left in flight is torn down by the
 * next run, and ends by replacing the agent's messages — losing anything added in between.
 *
 * EXCEPT WHILE THE BOT IS ANSWERING. A join stays open until the thread's turn is over, so joining a
 * conversation whose Bot is still writing is a join that outlives any deadline, and it is the only
 * thing bringing the rest of that reply to this screen. Ended at the deadline, the reply stopped
 * where the join was, mid-word ("Which colour of apple do"), and stayed that way until a reload.
 * Nothing can be lost by letting it run: while it does the agent is running, so nothing is sent.
 */

/**
 * Resolves once `connect` has finished, ending it early if `deadline` comes first.
 *
 * Says which: `"connected"` when the connect finished on its own, `"deadline"` when it was ended.
 * Whatever an ended connect replayed stops part way through the thread's history, so a caller that
 * reads something off the replay (how the last run ended) cannot trust it after `"deadline"`.
 *
 * A join that is carrying a turn still going (`answering`) is not ended at the deadline: the caller
 * is told (`onAnswering`), so it can show what has arrived, and this resolves when the turn is over.
 */
export async function joinWithin({
  connect,
  deadline,
  detach,
  answering = () => false,
  onAnswering = () => {},
}: {
  /** The join already in progress. Its rejection is an outcome, not a failure of this function. */
  connect: Promise<unknown>;
  /** How long the join is worth waiting for. Resolving means "stop waiting", not "stop". */
  deadline: Promise<void>;
  /** End the in-flight connect. Asked for once, and only when the deadline came first. */
  detach: () => Promise<unknown>;
  /** Whether the join, at the deadline, is carrying a turn the Bot has not finished. */
  answering?: () => boolean;
  /** Called once, at the deadline, when the join is left to carry that turn to its end. */
  onAnswering?: () => void;
}): Promise<"connected" | "deadline"> {
  // Settled either way: a connect that failed is a join that is over, and the caller restores
  // history separately. Kept as one promise so it can be awaited twice without a second rejection.
  const finished = connect.then(
    () => undefined,
    () => undefined,
  );

  const outcome = await Promise.race([
    finished.then(() => "connected" as const),
    deadline.then(() => "deadline" as const),
  ]);
  if (outcome === "connected") {
    return outcome;
  }
  if (answering()) {
    onAnswering();
    await finished;
    return "connected";
  }

  try {
    await detach();
  } catch {
    // A detach with nothing to detach is not a problem worth reporting, and the wait below is what
    // this function actually promises. Swallowing it here keeps that promise on both paths.
  }
  /*
   * Bounded, because a detach is a request and not a guarantee.
   *
   * This was a bare `await finished`, on the reasoning that a detached connect ends promptly. When
   * it does not, nothing here ever returns: the caller's `finally` never runs, the gate it opens
   * stays shut, and every message typed afterwards waits on it forever. That is silence — the
   * message appears in the transcript, no run is ever started, no request reaches the server and
   * nothing is logged, which is the hardest failure of all to read.
   *
   * A connect still running after this grace has outlived its usefulness either way. Going on
   * without it risks the overwrite this function exists to prevent; waiting for it risks a
   * conversation that never answers again. The first is recoverable and visible. The second is not.
   */
  await Promise.race([finished, afterMs(DETACH_GRACE_MS)]);
  return outcome;
}

/**
 * How long a detached connect is given to finish before the turn goes ahead regardless.
 *
 * Long enough that an ending connect is waited for, short enough that a stuck one is not the end of
 * the conversation.
 */
const DETACH_GRACE_MS = 2_000;

/** A deadline, as a promise. Separate so a test can supply one it controls. */
export function afterMs(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
