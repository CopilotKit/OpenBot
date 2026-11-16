import { expect, test } from "bun:test";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { OPERATION_IDS, PATHS, TEXT } from "./support/intelligence-api-markers";

/**
 * Guard: no copy of CopilotKit Intelligence's own API description, and no client generated from it,
 * is ever in this repository. OpenBot reaches Intelligence as it ships and describes only its own
 * operations; the markers, and why each one gives a copy away, are in one list,
 * tests/support/intelligence-api-markers.ts.
 *
 * Read is every file git would commit: the tracked ones, and new ones git does not ignore, so a copy
 * is caught before it is committed as well as in CI. A path is refused by where it sits, whatever it
 * holds; a file's text by what it says. Binary files are passed over, and so is the list of markers,
 * which has to name what it looks for.
 */
const REPO = join(import.meta.dir, "..");
const MARKERS = "tests/support/intelligence-api-markers.ts";

/** Every file git would commit, as a path from the repository's root. */
function files(): string[] {
  const listed = Bun.spawnSync(
    ["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { cwd: REPO },
  );
  if (listed.exitCode !== 0)
    throw new Error(`git ls-files failed: ${listed.stderr.toString()}`);
  return [...new Set(listed.stdout.toString().split("\0").filter(Boolean))];
}

/** What gives a file away as a copy, as `path[:line]  why`; nothing for a file of OpenBot's own. */
export function copiesIn(path: string, text: string | null): string[] {
  const found = PATHS.filter((marker) => marker.pattern.test(path)).map(
    (marker) => `${path}  ${marker.why}`,
  );
  if (text === null) return found;
  for (const marker of TEXT) {
    const match = marker.pattern.exec(text);
    if (!match) continue;
    const line = text.slice(0, match.index).split("\n").length;
    found.push(`${path}:${line}  ${marker.why}`);
  }
  return found;
}

/** A file's text, or null for one that is gone, is not a file, or is binary. */
function textOf(path: string): string | null {
  const full = join(REPO, path);
  try {
    if (!statSync(full).isFile()) return null;
  } catch {
    // Deleted in this checkout and not yet committed: there is nothing to read.
    return null;
  }
  const bytes = readFileSync(full);
  return bytes.includes(0) ? null : bytes.toString("utf8");
}

test("no file in the repository is a copy of Intelligence's API description or a client made from it", () => {
  const found = files()
    .filter((path) => path !== MARKERS)
    .flatMap((path) => copiesIn(path, textOf(path)));
  expect(found).toEqual([]);
}, 60_000);

test("the scan finds what it is for, and passes OpenBot's own spec", () => {
  // A scanner that finds nothing passes every tree. The samples are put together here, so this file
  // never holds a marker itself.
  const runs = OPERATION_IDS.find((id) => id.endsWith("Runs")) ?? "";
  // As a generator capitalises it inside a longer name.
  const listRuns = `${runs.charAt(0).toUpperCase()}${runs.slice(1)}`;
  expect(listRuns).not.toBe("");
  const extension = ["x", "cpki", "visibility"].join("-");
  for (const [path, text] of [
    [
      "api/openapi.yaml",
      `paths:\n  /runs:\n    get:\n      ${extension}: internal\n`,
    ],
    [
      "api/openapi.yaml",
      `info:\n  title: ${["Intelligence", "Product", "API"].join(" ")}\n`,
    ],
    ...OPERATION_IDS.map((id) => ["api/openapi.yaml", `operationId: ${id}\n`]),
    [
      "app/src/lib/api/generated/learning.ts",
      `export const use${listRuns} = () => {};\n`,
    ],
    [
      "app/src/lib/api/generated/learning.ts",
      `export const get${listRuns}Url = () => "";\n`,
    ],
    [
      "app/src/lib/api/generated/model/x.ts",
      `export type ${listRuns}Params = {};\n`,
    ],
  ] as const)
    expect({ path, caught: copiesIn(path, text).length > 0 }).toEqual({
      path,
      caught: true,
    });

  for (const path of [
    "api/vendor/intelligence/openapi.yaml",
    "app/src/lib/api/intelligence/learning.ts",
    "third_party/vendor/copilotkit-intelligence/spec.yaml",
  ])
    expect({ path, caught: copiesIn(path, "").length > 0 }).toEqual({
      path,
      caught: true,
    });

  // OpenBot's own: its spec, its extensions, its reserved names, and Learning words of its own.
  for (const [path, text] of [
    ["api/intelligence-reserved.yaml", "prefixes:\n  - learning-\n"],
    ["api/openapi/admin-settings.yaml", "x-openbot-singleton: true\n"],
    [
      "api/openapi/learning.yaml",
      "operationId: listPersonalLearningProposals\noperationId: getLearningSettings\n",
    ],
    ["app/src/lib/learning/queries.ts", 'const KEY = ["learning", "runs"];\n'],
    [
      "app/src/lib/learning/mutations.ts",
      `export function ${OPERATION_IDS.find((id) => id.startsWith("start"))}MutationOptions() {}\n`,
    ],
  ] as const)
    expect({ path, found: copiesIn(path, text) }).toEqual({ path, found: [] });
});
