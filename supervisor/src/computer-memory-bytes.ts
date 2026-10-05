/**
 * Optional Docker memory cap for each computer, from `COMPUTER_MEMORY_BYTES`.
 *
 * Unset or empty (compose blank, leftover `.env` line) means no cap. The same empty-string and
 * prefix traps as `listenPort`: `Number.parseInt("", 10)` is `NaN` (silently dropped) and
 * `Number.parseInt("512m", 10)` is `512` bytes, which Docker accepts and Chromium cannot live in.
 */
export function computerMemoryBytes(
  raw: string | undefined,
): { ok: true; bytes: number | undefined } | { ok: false; reason: string } {
  const trimmed = raw?.trim();
  if (!trimmed) return { ok: true, bytes: undefined };
  if (!/^\d+$/.test(trimmed)) {
    return {
      ok: false,
      reason: `COMPUTER_MEMORY_BYTES must be a whole number of bytes (got ${JSON.stringify(raw)}).`,
    };
  }
  const value = Number.parseInt(trimmed, 10);
  if (value < 1) {
    return {
      ok: false,
      reason: `COMPUTER_MEMORY_BYTES must be a whole number of bytes (got ${JSON.stringify(raw)}).`,
    };
  }
  return { ok: true, bytes: value };
}
