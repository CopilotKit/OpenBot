#!/usr/bin/env bun
// Type-check `server/tests` against a frozen baseline of the errors that were already there.
//
// WHY A BASELINE AND NOT A CLEAN GATE. `server/tsconfig.json` does not include `tests`, and the
// runner is bun, which erases types rather than checking them, so `bun run typecheck` reports CLEAN
// while real defects sit in the suite — broken `import type` paths that silently degrade a value to
// `any` (including in a shared helper, which voids its type guarantee for every file that uses it),
// stubs missing methods their interface requires, `number | undefined` passed where `number` is
// required. Turning the check on is one change; fixing what it finds is another, much larger one.
// Freezing the known set lets the check land green and start earning its keep immediately: a NEW
// error fails the build from today, and the existing ones get fixed on their own schedule.
//
// WHY THE PROJECT'S OWN CONFIG. The check runs `tsc -p server/tsconfig.tests.json`, which extends
// `server/tsconfig.json`. Checking these files with an ad-hoc `tsc file.ts` plus hand-written flags
// is unsound: it drags `src` in under options the project does not use and emits a flood of errors
// that are artefacts of the flags rather than defects. Any baseline produced that way is garbage.
//
// KEYED BY FILE + CODE + MESSAGE, NEVER BY `path:line`. The same discipline as
// `scripts/mutation-register.ts`: a line-keyed list goes red when someone adds an import above a
// baselined error, every shifted error reads as "new", and people learn to run `--update` without
// reading — which is exactly how real debt gets silenced. An entry names the error, not where it
// sits. The comparison is a MULTISET, so position-free keys lose nothing: two identical errors in
// one file need two entries, and a third one fails.
//
// Usage:
//   bun scripts/typecheck-tests.ts            # check against the baseline; exit 1 on a new error
//   bun scripts/typecheck-tests.ts --update   # rewrite the baseline from the current output

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const project = join("server", "tsconfig.tests.json");
const baselinePath = join(
  repoRoot,
  "server",
  "tests",
  "typecheck-baseline.txt",
);

const header = [
  "# Frozen type errors in `server/tests`, as reported by",
  "#   bunx tsc --noEmit -p server/tsconfig.tests.json",
  "# One line per error: <file>: error TS<code>: <message>. NO line or column: an entry names the",
  '# error, not where it sits, so adding a line above it does not turn it into a "new" error.',
  "# The indented elaboration lines are dropped too.",
  "#",
  "# This file is a RECORD OF DEBT, not a list of things that are fine. Every line is a real defect",
  "# that the suite could not see because it was never type-checked. Fixing one and deleting its",
  "# line is always correct. ADDING a line is not: a new error means code written today is wrong,",
  "# and the gate exists to say so. Regenerate with `bun scripts/typecheck-tests.ts --update` only",
  "# after a deliberate decision that the new entries are pre-existing debt being surfaced rather",
  "# than debt being created.",
  "#",
  "# Sorted. Duplicates are significant: a line repeated N times allows exactly N identical errors",
  "# in that file, and an N+1th is new.",
];

// `path(line,col): error TScode: message` — the first line of a diagnostic. Elaborations are
// indented, so anchoring on a non-space first character drops them.
const DIAGNOSTIC = /^(\S[^(]*)\((\d+),\d+\): error (TS\d+): (.*)$/;

function runTsc(): string {
  const result = Bun.spawnSync({
    cmd: ["bunx", "tsc", "--noEmit", "--pretty", "false", "-p", project],
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  return `${result.stdout.toString()}${result.stderr.toString()}`;
}

// One diagnostic: `key` is what the baseline compares on (file, code, message — no position);
// `line` is kept only to point at a new error in the failure report.
interface Diagnostic {
  key: string;
  line: number;
}

function parse(output: string): Diagnostic[] {
  const errors: Diagnostic[] = [];
  for (const raw of output.split("\n")) {
    const match = DIAGNOSTIC.exec(raw.trimEnd());
    if (!match) continue;
    const [, file, line, code, message] = match;
    // tsc prints the project-relative path in the location, but absolute paths inside some
    // messages (TS6142 names the resolved file). Strip the checkout prefix so the baseline is
    // the same on a laptop, in a worktree and on CI.
    const key = `${file}: error ${code}: ${message}`.replaceAll(
      `${repoRoot}/`,
      "",
    );
    errors.push({ key, line: Number(line) });
  }
  return errors.sort((a, b) =>
    a.key === b.key ? a.line - b.line : a.key < b.key ? -1 : 1,
  );
}

function readBaseline(): string[] {
  if (!existsSync(baselinePath)) return [];
  return readFileSync(baselinePath, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "" && !line.startsWith("#"))
    .sort();
}

// Multiset difference: three identical errors in the baseline and four in the output is ONE new
// error, not zero. A set would swallow it. This is what makes a position-free key safe: a second
// copy of an already-baselined error in the same file still fails.
function subtract(from: string[], remove: string[]): string[] {
  const counts = new Map<string, number>();
  for (const line of remove) counts.set(line, (counts.get(line) ?? 0) + 1);
  const left: string[] = [];
  for (const line of from) {
    const n = counts.get(line) ?? 0;
    if (n > 0) counts.set(line, n - 1);
    else left.push(line);
  }
  return left;
}

const output = runTsc();
const diagnostics = parse(output);
const actual = diagnostics.map((d) => d.key);

// A tsc crash, a bad config or a missing dependency produces output with no parseable diagnostic
// and a non-empty body. Treat that as a failure rather than as "zero errors, all good" — a gate
// that goes green when its checker did not run is the defect this whole exercise exists to kill.
if (actual.length === 0 && output.trim() !== "") {
  console.error("tsc produced output but no parseable diagnostics:\n");
  console.error(output);
  process.exit(1);
}

if (process.argv.includes("--update")) {
  writeFileSync(baselinePath, `${[...header, ...actual].join("\n")}\n`);
  console.log(`Wrote ${actual.length} baseline entries to ${baselinePath}`);
  process.exit(0);
}

// A missing baseline is not "no known debt" — it is a checkout or merge that lost the file, and
// reporting every frozen error as NEW would bury that. Say what actually happened.
if (!existsSync(baselinePath) && actual.length > 0) {
  console.error(
    `No baseline at ${baselinePath}, and tsc reports ${actual.length} error(s) in server/tests.` +
      "\nRestore the file; do not regenerate it with --update to get past this.",
  );
  process.exit(1);
}

const baseline = readBaseline();
const added = subtract(actual, baseline);
const fixed = subtract(baseline, actual);

if (fixed.length > 0) {
  // Not a failure. Fixing an error must never break the build; it only makes the baseline stale.
  console.log(
    `${fixed.length} baselined error(s) no longer occur. Drop them from the baseline:`,
  );
  for (const line of fixed) console.log(`  - ${line}`);
  console.log("");
}

if (added.length > 0) {
  console.error(
    `${added.length} NEW type error(s) in server/tests, not in the baseline:\n`,
  );
  // The key carries no position, and when a key occurs more often than the baseline allows there
  // is no telling WHICH occurrence is the new one. So print every line it occurs on.
  for (const key of new Set(added)) {
    const lines = diagnostics.filter((d) => d.key === key).map((d) => d.line);
    const extra = added.filter((k) => k === key).length;
    const where =
      lines.length === extra
        ? `line ${lines.join(", ")}`
        : `${extra} new among lines ${lines.join(", ")}`;
    console.error(`  ${key}\n    (${where})`);
  }
  console.error(
    "\nFix them. Do not run --update to silence them: the baseline records debt that predates" +
      "\nthe gate, and an error reported here was introduced after it.",
  );
  process.exit(1);
}

console.log(
  `server/tests type-check clean against the baseline (${actual.length} known error(s)).`,
);
