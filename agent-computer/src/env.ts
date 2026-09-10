/**
 * A positive number from the environment, or the fallback.
 *
 * `Number.parseInt(process.env.X ?? "default")` is not enough: an unset variable declared in a
 * compose file arrives as an empty string rather than as absent, so `??` never fires and the parse
 * yields `NaN`. Empty, absent, non-numeric and non-positive all mean "not set" and take the fallback.
 *
 * `zeroSwitchesItOff` is for the one setting where zero is an answer rather than a mistake.
 * `COMPUTER_BROWSER_IDLE_MS=0` is documented as "keeps them resident", and `chooseIdle` reads a
 * timeout of zero as the sweep being switched off — but the value never reached it, because zero is
 * not greater than zero, so an operator who switched the sweep off got the thirty-minute default and
 * their browsers were closed anyway. It stays off by default: a cap of zero closes every browser the
 * moment it opens, and a timeout of zero would be the same mistake if it were read from a blank
 * variable rather than from an operator who typed it.
 *
 * Empty, absent, non-numeric and negative still take the fallback either way. That is what keeps the
 * empty string a compose file passes for an unset variable from switching a sweep off by accident,
 * which is the whole reason this function exists rather than a bare `Number`.
 *
 * Its own module, free of the `playwright` import `profiles.ts` carries, so a test can reach it
 * without loading a browser driver that is not installed where the tests run.
 */
export function numberFromEnv(
  name: string,
  fallback: number,
  { zeroSwitchesItOff = false }: { zeroSwitchesItOff?: boolean } = {},
): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return (zeroSwitchesItOff ? value >= 0 : value > 0) ? value : fallback;
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
