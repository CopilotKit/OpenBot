// The register's STATIC half, cheap enough for every test run: every entry still finds the exact
// expression it guards, its mutant still parses, and its named suites exist. Running the mutants
// themselves is `bun run test:mutations` (scripts/mutation-register.ts) — that is the half that
// proves the suites go red, and it spawns one `bun test` per entry, so it is not run from here.
//
// Why bother with this half: an entry whose expression was refactored away fails `test:mutations`
// loudly, but only when somebody runs it. This makes the same drift fail the ordinary suite, on the
// change that caused it, while the person who moved the code still knows what it was.

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ANCHOR_WINDOW,
  locate,
  type MutationEntry,
  mutate,
  REGISTER,
  REPO_ROOT,
} from "./mutation-register";

const transpilers = {
  ts: new Bun.Transpiler({ loader: "ts" }),
  tsx: new Bun.Transpiler({ loader: "tsx" }),
};

describe("every register entry", () => {
  test("has a unique id", () => {
    const ids = REGISTER.map((e) => e.id);
    expect(ids.filter((id, i) => ids.indexOf(id) !== i)).toEqual([]);
  });

  for (const entry of REGISTER) {
    test(`${entry.id}: locates its quoted expression, and its mutant parses`, () => {
      const source = readFileSync(join(REPO_ROOT, entry.path), "utf8");
      expect(locate(source, entry)).not.toHaveProperty("error");
      const mutant = mutate(source, entry);
      expect(mutant).not.toBe(source);
      // A syntax error would make every named test "fail" without telling any distinction apart.
      const transpiler = entry.path.endsWith(".tsx")
        ? transpilers.tsx
        : transpilers.ts;
      expect(() => transpiler.transformSync(source)).not.toThrow();
      expect(() => transpiler.transformSync(mutant)).not.toThrow();
    });

    test(`${entry.id}: names 1-3 test files that exist`, () => {
      expect(entry.tests.length).toBeGreaterThanOrEqual(1);
      expect(entry.tests.length).toBeLessThanOrEqual(3);
      for (const file of entry.tests) {
        expect(existsSync(join(REPO_ROOT, file))).toBe(true);
      }
    });
  }
});

describe("locate", () => {
  const entry = (over: Partial<MutationEntry>): MutationEntry => ({
    id: "x",
    kind: "identity",
    path: "f.ts",
    find: "a.vendorUserId",
    replace: "a.userId",
    tests: ["t.test.ts"],
    why: "",
    ...over,
  });

  test("refuses a bare expression that occurs twice, rather than picking one", () => {
    const source = "f(a.vendorUserId);\ng(a.vendorUserId);";
    expect(locate(source, entry({}))).toHaveProperty("error");
  });

  test("an anchor picks the occurrence after it", () => {
    const source = "f(a.vendorUserId);\nfunction g() { h(a.vendorUserId); }";
    const found = locate(source, entry({ anchor: "function g() {" }));
    expect(found).toEqual({ index: source.lastIndexOf("a.vendorUserId") });
  });

  test("does not re-aim at a sibling past the window when the guarded line is deleted", () => {
    // The guarded expression after `function g() {` is gone; the next occurrence belongs to `k`.
    const source = `function g() { h(); }\n${" ".repeat(ANCHOR_WINDOW)}\nfunction k() { h(a.vendorUserId); }`;
    expect(locate(source, entry({ anchor: "function g() {" }))).toHaveProperty(
      "error",
    );
  });

  test("refuses an anchor that is not unique", () => {
    const source = "function g() { a.vendorUserId }\nfunction g() {}";
    expect(locate(source, entry({ anchor: "function g() {" }))).toHaveProperty(
      "error",
    );
  });
});
