/**
 * Joining a channel's durable thread, bounded, and OVER when it says it is over.
 *
 * THE DEADLINE ENDS THE CONNECT RATHER THAN OUTRUNNING IT: one left in flight is torn down by the
 * next run, and ends by replacing the agent's messages — losing anything added in between.
 */

/** Resolves once `connect` has finished, ending it early if `deadline` comes first. */
export async function joinWithin({
  connect,
  deadline,
  detach,
}: {
  /** The join already in progress. Its rejection is an outcome, not a failure of this function. */
  connect: Promise<unknown>;
  /** How long the join is worth waiting for. Resolving means "stop waiting", not "stop". */
  deadline: Promise<void>;
  /** End the in-flight connect. Asked for once, and only when the deadline came first. */
  detach: () => Promise<unknown>;
}): Promise<void> {
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
    return;
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
