/**
 * Which Bots' browsers to close, and when.
 *
 * Its own file, with no Playwright import, for the reason `authorisation.ts` and `bot-id.ts` are:
 * `profiles.ts` imports Playwright at module scope, so anything living there needs a browser merely
 * to be imported by a test. A decision this size should be testable without one, and `profiles.ts`
 * owns the launching, so a test that went through it would be testing Playwright rather than the
 * choice being made.
 *
 * The choice is worth testing on its own. There was no cap and no timeout: a context was started the
 * first time each Bot was used and kept, and the only things that dropped one were an explicit stop,
 * a browser that had already died, and shutdown. A deployment where every employee has a Bot trends
 * toward one resident Chromium per employee in a single container, at a few hundred MB each, until
 * it is killed for memory and relaunches its way back to the same state.
 *
 * Closing one loses nothing. The profile is on disk, so the Bot's logins survive and its next request
 * starts where it left off, which is already what `stop` means here.
 */

/** Enough of a live entry for either decision. Keeps this file independent of what else is on one. */
export type Evictable = { usedAt: number };

/**
 * Which to close because there are too many running.
 *
 * Least recently used first: the Bot that has been quiet longest. Applied after a launch, so the Bot
 * that just asked is the most recently used and is therefore never the one closed.
 */
export function chooseEvictions(
  running: Iterable<[string, Evictable]>,
  max: number,
): string[] {
  const entries = [...running];
  if (entries.length <= max) return [];

  return entries
    .sort(([, a], [, b]) => a.usedAt - b.usedAt)
    .slice(0, entries.length - max)
    .map(([botId]) => botId);
}

/**
 * Which to close because nothing has touched them.
 *
 * The other half of the answer: a deployment under the cap still holds a browser for a Bot used once
 * last Tuesday, and that memory is doing nothing for anybody. A timeout of zero or less switches this
 * off, so a deployment can keep browsers resident if it would rather.
 */
export function chooseIdle(
  running: Iterable<[string, Evictable]>,
  idleTimeoutMs: number,
  now: number,
): string[] {
  if (idleTimeoutMs <= 0) return [];
  const cutoff = now - idleTimeoutMs;

  return [...running]
    .filter(([, entry]) => entry.usedAt <= cutoff)
    .map(([botId]) => botId);
}
