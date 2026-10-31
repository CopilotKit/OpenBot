import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * Guard: a comment says why the code is as it is, in the code's own terms, never that a review asked for it.
 *
 * The Recorder's and the OpenBot Browser's tests (and a few of Desktop's) said "the code-owner review", "blocker 3" or
 * "end-to-end run 1 of the review fixes" where the reason belonged: which defect the test pins, what a person saw. That
 * is review history, which the pull request keeps; to someone reading the test next year it says only that somebody
 * once asked, and nothing of what breaks if the test goes. So the sources and tests of the parts that work was in are
 * read for those phrases, and each that turns up is to be rewritten to the reason.
 */
const REPO = join(import.meta.dir, "..", "..");
const ROOTS = [
  "app/src",
  "app/tests",
  "agent-computer/src",
  "agent-computer/tests",
  "desktop/src-tauri/src",
  "extension/src",
  "extension/tests",
  "server/src",
  "server/tests",
  "shared",
];
const SOURCE = /\.(ts|tsx|rs)$/;
/** Review history standing in for a reason. */
const HISTORY =
  /code[- ]owner(?:'s)? review|review fixes|blocker \d of the|the review's blocker/i;

function* files(directory: string): Generator<string> {
  for (const name of readdirSync(directory)) {
    if (name === "node_modules" || name === "target" || name === "dist")
      continue;
    const path = join(directory, name);
    if (statSync(path).isDirectory()) yield* files(path);
    else if (SOURCE.test(name)) yield path;
  }
}

test("no comment gives a review as the reason for the code", () => {
  const found: string[] = [];
  for (const root of ROOTS)
    for (const path of files(join(REPO, root))) {
      // This file names the phrases it looks for.
      if (path === import.meta.path) continue;
      readFileSync(path, "utf8")
        .split("\n")
        .forEach((line, index) => {
          if (HISTORY.test(line))
            found.push(`${relative(REPO, path)}:${index + 1}  ${line.trim()}`);
        });
    }
  expect(found).toEqual([]);
});
