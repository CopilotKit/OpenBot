import { timingSafeEqual } from "node:crypto";

/**
 * Whether a request's `Authorization` header carries the supervisor's secret.
 *
 * Compared in constant time, as the server (`sameToken`) and the computer (`matchesToken`) already
 * compare theirs. A plain `!==` stops at the first differing character, so the time a refusal takes
 * says how much of a guess was right. This process holds the Docker socket, so it should leak no
 * less than the services it creates. Length still leaks; content does not.
 *
 * Kept out of `index.ts`, which exits at import without its environment, so a test can reach it.
 */
export function authorised(header: string | undefined, token: string): boolean {
  if (!token || !header) return false;
  const offered = Buffer.from(header);
  const expected = Buffer.from(`Bearer ${token}`);
  if (offered.length !== expected.length) return false;
  return timingSafeEqual(offered, expected);
}
