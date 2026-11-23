import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { PLAYWRIGHT } from "./cliPage";
import type { Finding, FindingsFile } from "./findings";
import { sceneEnd } from "./sceneCatalog";
import { SCENES } from "./scenes";
import {
  ensureServer,
  HOOK_START_MS,
  HOOK_STOP_MS,
  type WorkbenchServer,
} from "./server";

/**
 * The Findings page: the check writes findings.json, the page lists its findings, a finding opens
 * its scene at its time with the warning marked, and Next goes to its next occurrence.
 *
 *   OPENBOT_APP_BROWSER=1 bun test workbench/findings.browser.test.ts
 */
const asked = process.env.OPENBOT_APP_BROWSER === "1";

const DESKTOP_DIR = join(import.meta.dir, "..");
/** A folder of its own under the folder the server reads, so this run's file is the newest. */
const OUT = join(
  DESKTOP_DIR,
  "workbench-shots",
  "check",
  `findings-test-${process.pid}`,
);
/** A move-to-cloud scene where one paragraph moves the same way twice: two occurrences. */
const SCENE = "move-to-cloud-fails";

type Page = {
  goto(url: string): Promise<unknown>;
  waitForFunction<A>(
    run: (arg: A) => unknown,
    arg?: A,
    options?: { timeout: number },
  ): Promise<unknown>;
  waitForSelector(selector: string): Promise<unknown>;
  evaluate<T, A = undefined>(run: (arg: A) => T, arg?: A): Promise<T>;
  click(selector: string): Promise<void>;
  keyboard: { press(key: string): Promise<void> };
  locator(selector: string): { allTextContents(): Promise<string[]> };
};
type Browser = { newPage(): Promise<Page>; close(): Promise<void> };

/** What the frame on the page shows now: its scene, its time and the mark it draws. */
function frameState(page: Page) {
  return page.evaluate(() => {
    const frame = document.querySelector<HTMLIFrameElement>(
      "[data-findings-frame]",
    );
    const win = frame?.contentWindow as
      | (Window & {
          __workbenchPage?: { ready: boolean; scene: string; now(): number };
        })
      | null;
    const wb = win?.__workbenchPage;
    return {
      ready: wb?.ready ?? false,
      scene: wb?.scene ?? "",
      now: wb?.now() ?? -1,
      highlight:
        win?.document
          .querySelector("[data-workbench-highlight]")
          ?.getAttribute("data-workbench-highlight") ?? null,
      step:
        document.querySelector("[data-occurrence]")?.textContent?.trim() ?? "",
    };
  });
}

/** Waits until the frame shows `scene` at `ms` with a mark drawn. */
async function waitForMark(
  page: Page,
  scene: string,
  ms: number,
): Promise<void> {
  await page.waitForFunction(
    ({ scene, ms }) => {
      const frame = document.querySelector<HTMLIFrameElement>(
        "[data-findings-frame]",
      );
      const win = frame?.contentWindow as
        | (Window & {
            __workbenchPage?: {
              ready: boolean;
              scene: string;
              now(): number;
            };
          })
        | null;
      const wb = win?.__workbenchPage;
      return (
        wb?.ready === true &&
        wb.scene === scene &&
        wb.now() === ms &&
        win?.document.querySelector("[data-workbench-highlight]") !== null
      );
    },
    { scene, ms },
    { timeout: 60_000 },
  );
}

describe.skipIf(!asked)("the Findings page", () => {
  let server: WorkbenchServer;
  let browser: Browser;
  let finding: Finding;

  beforeAll(async () => {
    server = await ensureServer();
    const { chromium } = (await import(PLAYWRIGHT)) as {
      chromium: { launch(o: { channel: string }): Promise<Browser> };
    };
    browser = await chromium.launch({ channel: "chromium" });
  }, HOOK_START_MS);

  afterAll(async () => {
    rmSync(OUT, { recursive: true, force: true });
    await browser?.close();
    await server?.stop();
  }, HOOK_STOP_MS);

  test("the check writes findings.json with the occurrences of the scene", async () => {
    const scene = SCENES.find((s) => s.id === SCENE);
    if (!scene) throw new Error(`There is no scene ${SCENE}.`);
    mkdirSync(OUT, { recursive: true });
    const proc = Bun.spawn(
      [
        "bun",
        "workbench/shot.ts",
        SCENE,
        "--at",
        String(sceneEnd(scene)),
        "--check",
        "--out",
        OUT,
      ],
      { cwd: DESKTOP_DIR, stdout: "pipe", stderr: "pipe" },
    );
    const [stderr, code] = await Promise.all([
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    expect(stderr).toBe("");
    expect(code).toBe(0);
    const file = JSON.parse(
      readFileSync(join(OUT, "findings.json"), "utf8"),
    ) as FindingsFile;
    expect(file.version).toBe(1);
    expect(file.sceneCount).toBe(1);
    // A layout finding that shows at two times of the scene, with its component's file.
    const twice = file.findings.find(
      (f) => f.kind === "moved" && f.occurrences.length >= 2,
    );
    if (!twice) throw new Error("No finding shows twice.");
    finding = twice;
    expect(finding.component?.file).toMatch(/^desktop\/src\//);
    expect(finding.occurrences.every((o) => o.scene.id === SCENE)).toBe(true);
    // Every move has a class, a rule and why.
    for (const f of file.findings.filter((f) => f.kind === "moved"))
      expect(f.movement?.why).toBeTruthy();
    const [first, second] = finding.occurrences;
    expect(first && second && first.at < second.at).toBe(true);
  }, 180_000);

  test("the page lists the findings and plays the selected one", async () => {
    const page = await browser.newPage();
    await page.goto(`${server.url}/workbench/findings/`);
    await page.waitForSelector(".fd-count");
    // By default the page hides the expected moves; the toggle shows them.
    const shownByDefault = await page.evaluate(
      () => document.querySelectorAll('.fd-row [data-class="expected"]').length,
    );
    expect(shownByDefault).toBe(0);
    await page.click(".fd-expected input");
    await page.waitForSelector(`[data-finding-id="${finding.id}"]`);
    const titles = await page.locator(".fd-row-title").allTextContents();
    expect(titles).toContain(finding.title);

    // Selecting it opens the scene at its first occurrence, with the move marked.
    await page.click(`[data-finding-id="${finding.id}"]`);
    const [first, second] = finding.occurrences;
    if (!first || !second) throw new Error("The finding has one occurrence.");
    await waitForMark(page, SCENE, first.at);
    let state = await frameState(page);
    expect(state.highlight).toBe("moved");
    expect(state.step).toBe(`1 of ${finding.occurrences.length}`);

    // The right arrow goes to the next occurrence: the same scene, at its later time.
    await page.evaluate(() => (document.activeElement as HTMLElement)?.blur());
    await page.keyboard.press("ArrowRight");
    await waitForMark(page, SCENE, second.at);
    state = await frameState(page);
    expect(state.highlight).toBe("moved");
    expect(state.step).toBe(`2 of ${finding.occurrences.length}`);

    // The Previous button goes back to the first one. That seek goes back in time, so the window
    // starts again under a still of itself; the still goes when the window is there.
    await page.click("button[aria-keyshortcuts='ArrowLeft']");
    await waitForMark(page, SCENE, first.at);
    await page.waitForFunction(
      () => {
        const frame = document.querySelector<HTMLIFrameElement>(
          "[data-findings-frame]",
        );
        return (
          frame?.contentDocument?.querySelector("[data-workbench-still]") ===
          null
        );
      },
      undefined,
      { timeout: 10_000 },
    );
  }, 180_000);

  test("the server says when no check runs", async () => {
    const status = await (
      await fetch(`${server.url}/__workbench/findings/status`)
    ).json();
    expect(status.running).toBe(false);
  }, 30_000);
});
