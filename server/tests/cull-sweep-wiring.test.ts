import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * What the sweep passes, asserted against the script's own source.
 *
 * The script cannot be imported to be tested: it opens a database and a computer provider at the top
 * level and runs a sweep as a side effect of loading. So the retention window it hands `purge` is the
 * one line in this fix that nothing executes, and every test around it passes the window itself,
 * which means they would all still be green with this line deleted.
 *
 * That is the failure this whole change is about, one level up: a value the caller never names
 * reaches nothing, and the sweep goes on looking like it worked. Read as text, the way
 * `tests/compose.test.ts` pins the variables Compose has to name, because the alternative is a fix
 * whose only load-bearing line is the untested one.
 *
 * WHAT THIS CANNOT SEE. It proves the argument is written and where its value comes from, not that
 * the sweep behaves. `computer-culler.integration.test.ts` owns the behaviour and runs the real
 * queue against a real database; this is only the wire between the two.
 */
const script = readFileSync(
  join(import.meta.dir, "..", "scripts", "cull-idle-computers.ts"),
  "utf8",
);

test("the cull sweep keeps a finished suspension for the configured idle window", () => {
  expect(script).toContain("finishedOlderThanMs: config.computer.idleAfterMs");
});

/**
 * And that the other half still gets its day.
 *
 * The two windows exist because they are different questions. A sweep that passed the idle window for
 * both would turn a suspension that keeps failing into one retried every few minutes, which is the
 * regression this fix could most easily cause and the one nothing else would report.
 */
test("and gives a suspension that gave up the longer window before it is tried again", () => {
  expect(script).toContain("olderThanMs: 24 * 60 * 60 * 1000");
});
