// server/tests/support/source-scan.test.ts
/**
 * Contract test for the shared scanner, written against the ENUMERATOR rather than the matcher.
 *
 * Every guard that grew its own copy of these primitives also grew a positive control, and every
 * one of those controls plants its offender in a file the enumerator already visits. A control
 * sited that way can only ever prove the pattern matches; it is structurally incapable of noticing
 * that the walk never reached the file, that the extension filter excluded it, that the line number
 * it reported was off by the height of a block comment, or that the offending expression was
 * wrapped across two physical lines. So the cases below are the ones no guard's own control can
 * reach: they build a fixture tree on disk, with nesting, extensions and formatting the real
 * sources may grow at any time, and ask the util what it sees.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { logicalLines, sourceFiles, stripComments } from "./source-scan";

let root = "";

/** Write `text` at `rel` under the fixture root, creating the directories it needs. */
function fixture(rel: string, text: string): string {
  const full = join(root, rel);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, text, "utf8");
  return full;
}

/** Paths relative to the fixture root, so an assertion reads as the tree it describes. */
function scan(exts: string[]): string[] {
  return sourceFiles(root, exts).map((p) => p.slice(root.length + 1));
}

const ALL = [".ts", ".tsx", ".js", ".jsx", ".mjs"];

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "source-scan-"));
  fixture("top.ts", "export const a = 1;\n");
  fixture("plain.js", "export const b = 2;\n");
  fixture("widget.jsx", "export const C = () => null;\n");
  fixture("module.mjs", "export const d = 4;\n");
  fixture("notes.md", "not source\n");
  fixture("nested/deep/buried.ts", "export const e = 5;\n");
  fixture("nested/index.ts", "export const f = 6;\n");
  fixture("other/index.ts", "export const g = 7;\n");
});

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

/* 1-4: WHAT THE WALK REACHES. Each of these is a file a non-recursive, .ts-only enumerator drops
 * on the floor while its guard reports green. */

test("a .js file is enumerated", () => {
  expect(scan(ALL)).toContain("plain.js");
  // And the extension list is honoured, so a guard that asks for .ts only still gets .ts only.
  expect(scan([".ts"])).not.toContain("plain.js");
});

test("a .jsx file is enumerated", () => {
  expect(scan(ALL)).toContain("widget.jsx");
  expect(scan([".tsx"])).not.toContain("widget.jsx");
});

test("an .mjs file is enumerated", () => {
  expect(scan(ALL)).toContain("module.mjs");
  expect(scan(ALL)).not.toContain("notes.md");
});

test("a file in a nested subdirectory is enumerated", () => {
  expect(scan(ALL)).toContain(join("nested", "deep", "buried.ts"));
  // The whole point: the directory the old enumerators stopped at holds more than it shows.
  expect(scan(ALL).length).toBeGreaterThan(5);
});

/* 5: WHAT A LINE IS. */

test("a prettier-wrapped expression is one logical line", () => {
  const src = [
    "const keep =",
    "  typeof search.x ===",
    '    "string";',
    "const other = 1;",
  ].join("\n");
  const lines = logicalLines(src);
  const wrapped = lines[0];
  expect(wrapped.line).toBe(1);
  expect(wrapped.text).toMatch(/typeof\s+search\.x\s*===\s*"string"/);
  // And it did not swallow the statement after it.
  expect(lines[1]).toEqual({ line: 4, text: "const other = 1;" });
});

/* 6-8: WHAT THE STRIPPER LEAVES BEHIND. */

test("a trailing comment does not remove its own code line", () => {
  const src = 'const url = "composio://gmail"; // the scheme\n';
  const stripped = stripComments(src);
  expect(stripped).toContain('const url = "composio://gmail";');
  expect(stripped).not.toContain("the scheme");
  // A stripper that drops the whole line would have failed its guard on a line holding no offence.
  expect(logicalLines(stripped)[0].text.trim()).toBe(
    'const url = "composio://gmail";',
  );
});

test("a block comment spanning lines preserves subsequent line numbers", () => {
  const src = [
    "/*",
    " * three lines of prose",
    " */",
    'const url = "arcade://gmail";',
  ].join("\n");
  const stripped = stripComments(src);
  expect(stripped.split("\n").length).toBe(4);
  const offender = logicalLines(stripped).find((l) =>
    /arcade:\/\//.test(l.text),
  );
  // 4, as the file reads it — not 1, which is what blanking a block comment to "" reports.
  expect(offender?.line).toBe(4);
});

test("a same-line offence after whitespace is still visible", () => {
  const src = '  /* why */ const url = "arcade://gmail"; /* trailing */\n';
  const stripped = stripComments(src);
  expect(stripped).toContain('const url = "arcade://gmail";');
  expect(stripped).not.toContain("why");
  expect(stripped).not.toContain("trailing");
  // Columns are preserved too, so the code sits where it sat.
  expect(stripped.split("\n")[0].length).toBe(src.length - 1);
  expect(logicalLines(stripped)[0].line).toBe(1);
});

/* 9: WHAT A FILE IS CALLED. */

test("a duplicate-name decoy does not collide", () => {
  const found = scan(ALL).filter((p) => p.endsWith("index.ts"));
  expect(found.sort()).toEqual([
    join("nested", "index.ts"),
    join("other", "index.ts"),
  ]);
  // Two distinct files with one basename: an enumerator keyed on the name would report one.
  expect(new Set(found).size).toBe(2);
});
