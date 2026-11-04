import { expect, test } from "bun:test";
import { join } from "node:path";

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
  // From this file's own folder, not the working directory: run from anywhere else, a path relative
  // to the working directory matches no file at all and the check passes having read nothing.
  const files = await Array.fromAsync(
    new Bun.Glob("**/*.test.ts").scan({ cwd: import.meta.dir }),
  );
  const leaking: string[] = [];
  for (const file of files) {
    const source = await Bun.file(join(import.meta.dir, file)).text();
    // `end` releases the pool as `close` does, and is what the files that already ended theirs call.
    const released =
      source.includes("$client.close") || source.includes("$client.end");
    if (source.includes("createDatabase(") && !released) {
      leaking.push(file);
    }
  }
  expect(leaking).toEqual([]);
});
