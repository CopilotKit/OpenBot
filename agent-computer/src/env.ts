/**
 * A positive number from the environment, or the fallback.
 *
 * `Number.parseInt(process.env.X ?? "default")` is not enough: an unset variable declared in a
 * compose file arrives as an empty string rather than as absent, so `??` never fires and the parse
 * yields `NaN`. Empty, absent, non-numeric and non-positive all mean "not set" and take the fallback.
 *
 * Its own module, free of the `playwright` import `profiles.ts` carries, so a test can reach it
 * without loading a browser driver that is not installed where the tests run.
 */
export function numberFromEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * Wait for something that ought to finish, and carry on when it does not.
 *
 * Closing a browser means asking Chromium and a CDP session to stop, and either can decline to
 * answer: a page that has already gone, a socket that is still open but dead, a renderer that is not
 * coming back. None of that is a reason for the caller to stop, and the callers here are the ones
 * that must not stop. A teardown that never settles otherwise pins the Bot it belongs to, blocks the
 * launch of whichever Bot triggered the eviction, and on the way out holds every profile's flush
 * until the container is killed instead.
 *
 * So the wait is bounded and the result is discarded either way, the same bargain `closeAndWait`
 * already makes: better to lose the last seconds of a cast than to never close anything again.
 * Rejections are swallowed for the same reason, since a failed stop and a slow one leave the caller
 * with the same work to do.
 */
export async function settleWithin(
  work: Promise<unknown> | undefined,
  budgetMs: number,
): Promise<void> {
  if (!work) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, budgetMs);
    // Housekeeping must never be the reason the process stays up.
    timer.unref?.();
  });
  try {
    await Promise.race([work.catch(() => undefined), deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
