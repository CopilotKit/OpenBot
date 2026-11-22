import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadImportedScenes, scenesForAll } from "./shot";

/**
 * The agent CLI saves a screenshot and a JSON report.
 *
 *   OPENBOT_APP_BROWSER=1 bun test workbench/shot.browser.test.ts
 */
const asked = process.env.OPENBOT_APP_BROWSER === "1";

const DESKTOP_DIR = join(import.meta.dir, "..");

async function run(args: string[]) {
  const proc = Bun.spawn(["bun", "workbench/shot.ts", ...args], {
    cwd: DESKTOP_DIR,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, code };
}

describe.skipIf(!asked)("workbench:shot", () => {
  test("saves a screenshot and a report", async () => {
    const out = mkdtempSync(join(tmpdir(), "shot-"));
    const result = await run([
      "install-mac",
      "--at",
      "52",
      "--grid",
      "--out",
      out,
    ]);
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);

    const png = readFileSync(join(out, "install-mac@52s.png"));
    const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
    expect(view.getUint32(16)).toBeGreaterThanOrEqual(1000);
    expect(view.getUint32(20)).toBeGreaterThanOrEqual(800);

    const report = JSON.parse(
      readFileSync(join(out, "install-mac@52s.json"), "utf8"),
    );
    expect(report.scene).toBe("install-mac");
    expect(report.at).toBe(52);
    expect(report.window.grid).toBe(true);
    expect(report.calls.length).toBeGreaterThan(0);
    expect(Array.isArray(report.elements)).toBe(true);
    expect(Array.isArray(report.warnings)).toBe(true);
  }, 120_000);

  test("--all --check finds no stalled run in the scenes", async () => {
    const out = mkdtempSync(join(tmpdir(), "shot-check-"));
    const result = await run(["--all", "--check", "--out", out]);
    // Each problem is one line: "<scene> at <s>s: <message>".
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    // Every committed scene, walked to its end: 155 s here and 299 s on CI's runner before three more
    // move scenes, so CI's limit of 300 s was reached. Three times CI's time, as scenes keep coming.
  }, 900_000);

  test("refuses an unknown scene", async () => {
    const result = await run(["no-such-scene"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("install-mac");
  }, 30_000);
});

describe("loadImportedScenes", () => {
  test("reads the scene files in a folder, in name order, and skips the rest", () => {
    const dir = mkdtempSync(join(tmpdir(), "imported-"));
    const scene = (id: string) => ({
      id,
      title: `Scene ${id}`,
      group: "Install",
      start: { hash: "", search: "" },
      run: [{ at: 1, click: "Install" }],
    });
    writeFileSync(join(dir, "b.json"), JSON.stringify(scene("log-b")));
    writeFileSync(join(dir, "a.json"), JSON.stringify(scene("log-a")));
    writeFileSync(join(dir, "broken.json"), "{");
    writeFileSync(join(dir, "other.json"), JSON.stringify({ id: "x" }));
    writeFileSync(join(dir, "notes.txt"), "not a scene");
    expect(loadImportedScenes(dir).map((s) => s.id)).toEqual([
      "log-a",
      "log-b",
    ]);
  });

  test("gives no scenes when the folder is missing", () => {
    expect(loadImportedScenes(join(tmpdir(), "no-such-folder-xyz"))).toEqual(
      [],
    );
  });
});

describe("scenesForAll", () => {
  const scene = (id: string) => ({
    id,
    title: id,
    group: "Install" as const,
    start: { hash: "", search: "" },
  });
  const scenes = [scene("install-mac"), scene("log-a"), scene("log-b")];
  const imported = new Set(["log-a", "log-b"]);

  test("--all --check skips the imported scenes and counts them", () => {
    const picked = scenesForAll(scenes, imported, {
      check: true,
      includeImported: false,
    });
    expect(picked.scenes.map((s) => s.id)).toEqual(["install-mac"]);
    expect(picked.skipped).toBe(2);
  });

  test("--include-imported keeps them with --check", () => {
    const picked = scenesForAll(scenes, imported, {
      check: true,
      includeImported: true,
    });
    expect(picked.scenes).toHaveLength(3);
    expect(picked.skipped).toBe(0);
  });

  test("--all without --check keeps them", () => {
    const picked = scenesForAll(scenes, imported, {
      check: false,
      includeImported: false,
    });
    expect(picked.scenes).toHaveLength(3);
    expect(picked.skipped).toBe(0);
  });
});
