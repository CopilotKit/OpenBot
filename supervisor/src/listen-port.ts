/**
 * Listen port for the container supervisor.
 *
 * An empty `PORT=` (compose blank, leftover `.env` line) is unset, not zero — the same empty-string
 * trap #96/#114/#312 found for the server and computer. `??` only fires on undefined, so
 * `Number.parseInt("", 10)` used to be `NaN` and `Bun.serve({ port: NaN })` bound an ephemeral port
 * while compose still published 4300. Prefix typos (`30o0`) also used to start on 30 via parseInt.
 */
export function listenPort(
  raw: string | undefined,
  fallback: number,
): { ok: true; port: number } | { ok: false; reason: string } {
  const trimmed = raw?.trim();
  if (!trimmed) return { ok: true, port: fallback };
  if (!/^\d+$/.test(trimmed)) {
    return {
      ok: false,
      reason: `PORT must be a whole number from 1 to 65535 (got ${JSON.stringify(raw)}).`,
    };
  }
  const value = Number.parseInt(trimmed, 10);
  if (value < 1 || value > 65535) {
    return {
      ok: false,
      reason: `PORT must be a whole number from 1 to 65535 (got ${JSON.stringify(raw)}).`,
    };
  }
  return { ok: true, port: value };
}
