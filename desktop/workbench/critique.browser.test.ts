import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The design-review CLI writes frame.png, frame.json and prompt.md for a frame.
 *
 *   OPENBOT_APP_BROWSER=1 bun test workbench/critique.browser.test.ts
 */
const asked = process.env.OPENBOT_APP_BROWSER === "1";

const DESKTOP_DIR = join(import.meta.dir, "..");

async function run(args: string[]) {
  const proc = Bun.spawn(["bun", "workbench/critique.ts", ...args], {
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

function expectFolder(dir: string, scene: string, at: number): string {
  for (const name of ["frame.png", "frame.json", "prompt.md"]) {
    expect(existsSync(join(dir, name))).toBe(true);
  }
  const png = readFileSync(join(dir, "frame.png"));
  expect(png.subarray(1, 4).toString()).toBe("PNG");
  const report = JSON.parse(readFileSync(join(dir, "frame.json"), "utf8"));
  expect(report.scene).toBe(scene);
  expect(report.at).toBe(at);
  expect(Array.isArray(report.elements)).toBe(true);
  expect(Array.isArray(report.warnings)).toBe(true);
  const prompt = readFileSync(join(dir, "prompt.md"), "utf8");
  expect(prompt.split("\n")[0]?.startsWith("/impeccable critique ")).toBe(true);
  expect(prompt).toContain(`bun run workbench:shot ${scene} --at ${at}`);
  return prompt;
}

describe.skipIf(!asked)("workbench:critique", () => {
  test("writes a review folder for a desktop scene", async () => {
    const out = mkdtempSync(join(tmpdir(), "critique-"));
    const result = await run(["install-mac", "--at", "52", "--out", out]);
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    const prompt = expectFolder(
      join(out, "install-mac@52s"),
      "install-mac",
      52,
    );
    // The elements' chains name the setup window's source.
    expect(prompt.split("\n")[0]).toMatch(
      /^\/impeccable critique desktop\/src\//,
    );
  }, 120_000);

  test("writes a review folder for an app scene", async () => {
    const out = mkdtempSync(join(tmpdir(), "critique-app-"));
    const result = await run(["app-settings-ai-refused", "--out", out]);
    expect(result.code).toBe(0);
    const prompt = expectFolder(
      join(out, "app-settings-ai-refused@0s"),
      "app-settings-ai-refused",
      0,
    );
    expect(prompt.split("\n")[0]).toMatch(/^\/impeccable critique app\/src\//);
    expect(prompt).toContain("- Route: /settings");
  }, 120_000);

  test("refuses an unknown scene and a bad flag", async () => {
    const unknown = await run(["no-such-scene"]);
    expect(unknown.code).toBe(2);
    expect(unknown.stderr).toContain("install-mac");
    const bad = await run(["install-mac", "--command", "redesign"]);
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain("Usage: bun run workbench:critique");
  }, 30_000);
});
