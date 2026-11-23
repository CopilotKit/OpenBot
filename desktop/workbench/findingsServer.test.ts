import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newestFindings, parseProgress } from "./findingsServer";
import { problemKind } from "./shot";

describe("newestFindings", () => {
  test("finds the newest findings.json in the folder or a folder under it", () => {
    const dir = mkdtempSync(join(tmpdir(), "findings-"));
    expect(newestFindings(dir)).toBeNull();
    writeFileSync(join(dir, "findings.json"), "{}");
    mkdirSync(join(dir, "run-2"));
    writeFileSync(join(dir, "run-2", "findings.json"), "{}");
    mkdirSync(join(dir, "empty"));
    const old = new Date(Date.now() - 60_000);
    utimesSync(join(dir, "findings.json"), old, old);
    expect(newestFindings(dir)?.path).toBe(join(dir, "run-2", "findings.json"));
    const later = new Date(Date.now() + 60_000);
    utimesSync(join(dir, "findings.json"), later, later);
    expect(newestFindings(dir)?.path).toBe(join(dir, "findings.json"));
  });

  test("is null for a folder that is not there", () => {
    expect(
      newestFindings(join(tmpdir(), "no-such-folder-findings")),
    ).toBeNull();
  });
});

describe("parseProgress", () => {
  test("reads shot.ts's scene line", () => {
    expect(parseProgress("Scene 3/57: install-mac")).toEqual({
      done: 2,
      total: 57,
      scene: "install-mac",
    });
    expect(parseProgress("/tmp/out/install-mac@52s.png")).toBeNull();
  });
});

describe("problemKind", () => {
  test("names the kind of a check problem by its message", () => {
    expect(problemKind("No answer for GET /api/v2/bots")).toBe("no-answer");
    expect(problemKind("Error in the app: boom")).toBe("app-error");
    expect(problemKind('Run step: nothing to click for "Install"')).toBe(
      "step",
    );
    expect(problemKind("The run stalled: no frame")).toBe("stalled");
  });
});
