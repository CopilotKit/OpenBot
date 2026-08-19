/**
 * How a stalled turn reads on the audit page.
 *
 * The row for a Bot that stopped talking carries two numbers nothing else in the trail carries: how
 * long its stream had been quiet when the deployment gave up on it, and how much it had managed to
 * say first. They are the whole reason that row exists. An endpoint that dies halfway through an
 * answer and one that accepts a connection and never writes are different faults with different
 * fixes, and on the page they are the same line unless these two are drawn.
 *
 * Chunks, not events, because that is what was counted: one chunk can carry several AG-UI events and
 * the boundaries are the network's. Saying "events" here would be a number that looks precise and is
 * not. What a reader needs from it is whether it is zero, and that it says plainly.
 *
 * Returns null rather than a placeholder when the payload does not carry both. An older row written
 * before this was recorded should show nothing, not "0 chunks", which would be a claim about a Bot
 * that nobody ever measured.
 */
export function silenceOf(payload: Record<string, unknown>): string | null {
  const silentForMs = payload.silentForMs;
  const chunks = payload.chunks;
  if (typeof silentForMs !== "number" || typeof chunks !== "number") {
    return null;
  }

  const seconds = Math.max(1, Math.round(silentForMs / 1000));
  const quiet = `Silent for ${seconds}s`;
  if (chunks === 0) return `${quiet}, having said nothing at all`;
  return `${quiet}, after ${chunks} ${chunks === 1 ? "chunk" : "chunks"}`;
}
