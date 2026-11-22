import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The agent CLI takes app scenes: it saves a screenshot and a JSON report of the app frame.
 *
 *   OPENBOT_APP_BROWSER=1 bun test workbench/appShot.browser.test.ts
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

type Report = {
  kind: string;
  calls: unknown[];
  requests: { method: string; path: string; source: string }[];
  elements: unknown[];
};

function readReport(out: string, name: string): Report {
  return JSON.parse(readFileSync(join(out, `${name}.json`), "utf8"));
}

describe.skipIf(!asked)("workbench:shot on app scenes", () => {
  test("saves a screenshot and a report of an app scene", async () => {
    const out = mkdtempSync(join(tmpdir(), "app-shot-"));
    const result = await run([
      "app-update-offered",
      "--at",
      "5",
      "--grid",
      "--out",
      out,
    ]);
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);

    const png = readFileSync(join(out, "app-update-offered@5s.png"));
    const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
    expect(view.getUint32(16)).toBeGreaterThanOrEqual(1000);
    expect(view.getUint32(20)).toBeGreaterThanOrEqual(800);

    const report = readReport(out, "app-update-offered@5s");
    expect(report.kind).toBe("app");
    expect(report.requests.length).toBeGreaterThan(0);
    const unanswered = report.requests.filter((r) => r.source === "none");
    expect(unanswered.map((r) => `${r.method} ${r.path}`)).toEqual([]);
    // The banner names the version that is offered.
    expect(
      report.elements.some((e) => JSON.stringify(e).includes("1.3.0")),
    ).toBe(true);
  }, 120_000);

  test("in a browser, the app calls no Desktop command", async () => {
    const out = mkdtempSync(join(tmpdir(), "app-shot-browser-"));
    const result = await run([
      "app-update-offered",
      "--at",
      "5",
      "--host",
      "browser",
      "--out",
      out,
    ]);
    expect(result.code).toBe(0);
    const report = readReport(out, "app-update-offered@5s");
    expect(report.kind).toBe("app");
    expect(report.calls).toEqual([]);
  }, 120_000);

  test("refuses an unknown app scene and lists the app scenes", async () => {
    const result = await run(["app-no-such-scene"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("app-home-bots");
  }, 60_000);
});
