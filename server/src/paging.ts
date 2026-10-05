/**
 * A page size from a `?limit=` query param, parsed strictly.
 *
 * `Number.parseInt` coerces: `"12abc"` reads as 12, `"3.9"` as 3, `"0x10"` as 0, so a typo
 * silently returns the wrong page and there is no 400 path at all. The audit list, the channel
 * list and the people list all share this rule, so every paged list answers the same way.
 *
 * Absent or blank means the caller did not ask, and the store's own default applies. A run of
 * digits is clamped into `1..max`, because the store clamps that way too and the edge saying the
 * same thing keeps a huge but well-formed ask from ever reaching the database as one. Anything
 * else is a caller error and answers 400 naming the parameter.
 */
export const PAGE_LIMIT_ERROR =
  'Query parameter "limit" must be a positive integer.';

export function parsePageLimit(
  raw: string | null,
  max: number,
): { ok: true; limit?: number } | { ok: false; error: string } {
  if (raw === null || raw.trim() === "") return { ok: true };
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return { ok: false, error: PAGE_LIMIT_ERROR };
  return {
    ok: true,
    limit: Math.min(Math.max(Number.parseInt(trimmed, 10), 1), max),
  };
}
