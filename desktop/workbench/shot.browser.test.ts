import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
  }, 300_000);

  test("refuses an unknown scene", async () => {
    const result = await run(["no-such-scene"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("install-mac");
  }, 30_000);
});
