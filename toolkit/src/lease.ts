/**
 * Keeping a thread's lock while a run works, shared by every turn that takes one.
 */

/**
 * Whether a failed renewal means the lock now belongs to somebody else.
 *
 * The platform answers a renewal for a lock this run no longer owns — expired, or taken by another
 * run — with 409 `THREAD_LOCK_RENEWAL_FAILED`, which it marks as not retryable. That is the fast way
 * to find out. It is not the only one: `keepLease` also stops once renewals have failed for longer
 * than the lock lives, whatever the failures were, so a runtime upgrade that renames this error
 * delays the stop to the lifetime rather than removing it.
 *
 * Matched on the shape, as `isMissingThread` is, because `PlatformRequestError` is not exported by
 * `@copilotkit/runtime`.
 */
export function isLockConflict(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.name === "PlatformRequestError" &&
    (error as { status?: unknown }).status === 409
  );
}

/**
 * No renewal has succeeded for nearly as long as the lock lives, so it will have lapsed before the
 * next one could land, whatever the reason was.
 */
export class LockLapsedError extends Error {
  override name = "LockLapsedError";
  constructor(lifetimeMs: number) {
    super(
      `The conversation's lock has not been renewed within its ${Math.round(lifetimeMs / 1000)}s lifetime, so it is lapsing and may be somebody else's.`,
    );
  }
}

/**
 * Renew a held lock every `everyMs` until stopped, and say when it is lost.
 *
 * Lost means one of two things, and either one stops the heartbeat and calls `onLost`, once:
 *
 * - A renewal is refused as a conflict ({@link isLockConflict}): somebody else holds it now.
 * - No renewal has succeeded for so long that the lock will have lapsed before the next tick:
 *   longer than `lifetimeMs - everyMs`, whatever the failures were — network errors, 5xx, 401, a
 *   request that never settles. Checked on each tick rather than when a renewal fails, because a
 *   renewal that hangs never fails. One interval short of the lifetime, so the turn stops while the
 *   lock is still its own rather than up to one interval after it has gone.
 *
 * Anything else is a renewal that did not land this time and is skipped; the next tick tries again.
 * That is the point of the lifetime: a blip shorter than it rides through, instead of stopping the
 * turn and having it re-run from the start. `lifetimeMs` counts from when this is called, which is
 * right after the lock was acquired with that lifetime.
 */
export function keepLease(input: {
  renew: () => Promise<unknown>;
  everyMs: number;
  lifetimeMs: number;
  onLost: (error: unknown) => void;
  /** The clock, for tests. */
  now?: () => number;
}): { stop: () => void } {
  const { renew, everyMs, lifetimeMs, onLost, now = Date.now } = input;
  // The last moment a tick can find the lock unrenewed and still stop before it lapses.
  const giveUpAfterMs = Math.max(lifetimeMs - everyMs, 0);
  let renewedAt = now();
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const stop = () => {
    if (heartbeat === undefined) return;
    clearInterval(heartbeat);
    heartbeat = undefined;
  };
  const lose = (error: unknown) => {
    if (heartbeat === undefined) return;
    stop();
    onLost(error);
  };
  heartbeat = setInterval(() => {
    if (now() - renewedAt > giveUpAfterMs) {
      lose(new LockLapsedError(lifetimeMs));
      return;
    }
    const asked = now();
    void renew().then(
      () => {
        // A renewal that lands late still only extends the lock from when it was asked for.
        if (heartbeat !== undefined) renewedAt = Math.max(renewedAt, asked);
      },
      (error: unknown) => {
        if (isLockConflict(error)) lose(error);
      },
    );
  }, everyMs);
  // So a heartbeat that is still pending cannot hold a one-shot process open.
  heartbeat.unref?.();
  return { stop };
}
