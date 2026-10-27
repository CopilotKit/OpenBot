import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

/**
 * Every pool a test file opens is closed by the same file (#785).
 *
 * The suite runs in a single process, so a module-scope pool nobody closes holds its two
 * connections for the rest of the run. PostgreSQL's ceiling is 100, and when it is crossed the
 * failure lands on whoever added the next file, not on anything they did wrong: #770's branch
 * saw 114 failures and 402 `sorry, too many clients already`, none of them about the change
 * under review.
 *
 * A pairing rule, checked against the file's own text: every `const <name> = createDatabase(`
 * needs a `<name>.$client.close()` (or the `$client.end(` some files already use) somewhere in
 * the same file. `server/tests` is outside `tsc`, so no type error would notice file 118 quietly
 * reintroducing the leak; this is what notices. The close must sit in the file's LAST top-level
 * `afterAll` (or one registered after every other hook): Bun runs `afterAll` hooks
 * first-registered-first, and a pool closed before a cleanup's deletes takes those deletes with
 * it.
 */
describe("every database pool a test file opens is closed", () => {
  test("each createDatabase variable is closed or ended in its own file", () => {
    const offenders: string[] = [];
    for (const file of readdirSync(import.meta.dir)
      .filter((name) => name.endsWith(".test.ts"))
      .sort()) {
      const text = readFileSync(join(import.meta.dir, file), "utf8");
      for (const match of text.matchAll(/const (\w+) = createDatabase\(/g)) {
        const name = match[1]!;
        if (
          !text.includes(`${name}.$client.close()`) &&
          !new RegExp(`\\b${name}\\.\\$client\\.end\\(`).test(text)
        ) {
          offenders.push(`${file}: ${name}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
