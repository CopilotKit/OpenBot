import { expect, test } from "bun:test";

/**
 * Every test file that opens a database pool closes it.
 *
 * `bun test` walks this directory in one process, and a pool a file leaves open keeps its
 * connections until the process exits. Enough of those and the suite dies against PostgreSQL's
 * connection ceiling as `sorry, too many clients already` — a failure that lands on whoever adds
 * the next file, not on the file that leaked.
 *
 * The close belongs in the file's last-registered `afterAll`, because Bun runs those
 * first-registered-first: a pool closed before the file's own cleanup takes the cleanup's queries
 * with it.
 *
 * A guard rather than a lint rule because "opens and closes" is a pairing, not an import
 * restriction, and `server/tests` is outside `tsc`, so types will not catch a missing one either.
 */
test("a file that opens a database pool closes it", async () => {
  const files = await Array.fromAsync(
    new Bun.Glob("server/tests/**/*.test.ts").scan({ cwd: process.cwd() }),
  );
  const leaking: string[] = [];
  for (const file of files) {
    const source = await Bun.file(file).text();
    if (source.includes("createDatabase(") && !source.includes("$client.close")) {
      leaking.push(file);
    }
  }
  expect(leaking).toEqual([]);
});
