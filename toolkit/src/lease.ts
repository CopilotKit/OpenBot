/**
 * Keeping a thread's lock while a run works, shared by every turn that takes one.
 */

/**
 * Whether a failed renewal means the lock now belongs to somebody else.
 *
 * The platform answers a renewal for a lock this run no longer owns — expired, or taken by another
 * run — with 409 `THREAD_LOCK_RENEWAL_FAILED`, which it marks as not retryable. Anything else is a
 * renewal that did not arrive: a network failure (no status at all) or a platform error (5xx). The
 * lock may well still be ours, and the platform's own lifetime leaves room for the next renewal.
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
 * Renew a held lock every `everyMs` until stopped.
 *
 * A renewal refused because the lock is somebody else's stops the heartbeat and calls `onLost`,
 * once: the caller stops its run rather than write events into another run's conversation. A
 * renewal that merely failed is skipped; the next one tries again, and if the lock did lapse in the
 * meantime, that next renewal is the one that comes back as a conflict.
 */
export function keepLease(input: {
  renew: () => Promise<unknown>;
  everyMs: number;
  onLost: (error: unknown) => void;
}): { stop: () => void } {
  const { renew, everyMs, onLost } = input;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const stop = () => {
    if (heartbeat === undefined) return;
    clearInterval(heartbeat);
    heartbeat = undefined;
  };
  heartbeat = setInterval(() => {
    void renew().catch((error: unknown) => {
      if (heartbeat === undefined || !isLockConflict(error)) return;
      stop();
      onLost(error);
    });
  }, everyMs);
  // So a heartbeat that is still pending cannot hold a one-shot process open.
  heartbeat.unref?.();
  return { stop };
}
