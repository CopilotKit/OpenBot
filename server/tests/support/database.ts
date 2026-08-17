/**
 * How many connections one test file may hold.
 *
 * The suite runs in a single process, so every file that opens a pool holds it for the whole run and
 * the totals add up rather than take turns. Left at the driver's default the suite sat at 83 of
 * PostgreSQL's 100, which is not a limit anybody set and not one that shows up until a file is added
 * and something unrelated fails on a machine slower than the author's.
 *
 * Two, because a test that opens a transaction and reads inside it needs a second connection to do
 * so. A test that wants the deadlock that pinning to one exposes asks for `{ max: 1 }` itself.
 */
export const TEST_POOL = { max: 2 } as const;
