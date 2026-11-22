import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  ensureServer,
  HOOK_START_MS,
  HOOK_STOP_MS,
  sharedChromium,
} from "./server";
import { DEFAULT_WINDOW, encodeState } from "./urlState";

/**
 * The workbench's motion stays truthful in a real browser: the paused "Next:" marker stays on its
 * element when the zoom or the stage changes, and a warning hover that seeks back never shows the
 * replay under it.
 *
 *   OPENBOT_APP_BROWSER=1 bun test workbench/motion.browser.test.ts
 */
const asked = process.env.OPENBOT_APP_BROWSER === "1";

/*
 * Playwright comes from the root install. The desktop's own jobs typecheck this file without it,
 * so the module is named by a variable and only the part used here is typed.
 */
const PLAYWRIGHT: string = "playwright-core";
type Locator = {
  click(): Promise<void>;
  hover(): Promise<void>;
  focus(): Promise<void>;
  press(key: string): Promise<void>;
  check(): Promise<void>;
  waitFor(options?: { state?: "visible" | "hidden" }): Promise<void>;
};
type Page = {
  goto(url: string): Promise<unknown>;
  waitForFunction(run: () => unknown): Promise<unknown>;
  waitForTimeout(ms: number): Promise<void>;
  waitForSelector(selector: string): Promise<unknown>;
  evaluate<T, A = undefined>(
    run: ((arg: A) => T) | string,
    arg?: A,
  ): Promise<T>;
  getByRole(role: string, options: { name: string | RegExp }): Locator;
  getByLabel(text: string, options?: { exact?: boolean }): Locator;
  locator(selector: string): Locator & { first(): Locator };
  mouse: { move(x: number, y: number): Promise<void> };
  close(): Promise<void>;
};
type Browser = {
  newPage(options: {
    viewport: { width: number; height: number };
    reducedMotion?: "reduce" | "no-preference";
  }): Promise<Page>;
};
type Chromium = { launch(options: { channel: string }): Promise<Browser> };

let browser: Browser | undefined;
let server: { url: string; stop(): Promise<void> } | undefined;

// The hooks name their time: bun gives a hook 5 s, and a server start or stop can take longer.
// bun test does not emit "exit", so stop() in afterAll is the only thing that gives the lease back.
beforeAll(async () => {
  if (!asked) return;
  server = await ensureServer();
  const { chromium } = (await import(PLAYWRIGHT)) as { chromium: Chromium };
  // Never closed: see sharedChromium.
  browser = await sharedChromium(() =>
    chromium.launch({ channel: "chromium" }),
  );
}, HOOK_START_MS);

afterAll(async () => {
  await server?.stop();
}, HOOK_STOP_MS);

async function openScene(page: Page, scene: string, at = 0): Promise<void> {
  if (!server) throw new Error("No server.");
  const query = encodeState({
    scene,
    at,
    answers: {},
    env: {},
    window: { ...DEFAULT_WINDOW, width: 1000, height: 800 },
  });
  await page.goto(`${server.url}/workbench/?${query}`);
  await page.waitForFunction(() => window.__workbenchPage?.ready === true);
}

/**
 * Where the "Next:" marker's box is in the window's own pixels (the frame's top left is 0, 0), and
 * the frame's scale. The element does not move in the window when the page zooms or the stage
 * changes, so this must stay the same.
 */
function markerInWindow(page: Page) {
  return page.evaluate(() => {
    const box = document.querySelector(".wb-action-next .wb-action-box");
    const frame = document.querySelector("[data-workbench-window] iframe");
    if (!box || !frame) return null;
    const b = box.getBoundingClientRect();
    const f = frame.getBoundingClientRect();
    const scale = f.width / (frame as HTMLIFrameElement).clientWidth || 1;
    return {
      x: (b.left - f.left) / scale,
      y: (b.top - f.top) / scale,
      scale,
    };
  });
}

describe.skipIf(!asked)("the workbench's motion", () => {
  test("the paused Next: marker stays on its element after Fit and a splitter drag", async () => {
    if (!browser) throw new Error("No browser.");
    const page = await browser.newPage({
      viewport: { width: 1600, height: 1000 },
    });
    try {
      await openScene(page, "install-mac");
      await page.getByLabel("Pause at each action").check();
      await page.getByRole("button", { name: "Play" }).click();
      await page.waitForSelector(".wb-action-next .wb-action-box");
      // Fit is on by default: the window is zoomed. One frame for the marker to settle.
      await page.waitForTimeout(100);
      const before = await markerInWindow(page);
      if (!before) throw new Error("No Next: marker.");

      const near = (now: NonNullable<typeof before>) => {
        // In page pixels: the marker within 1 px of where its element is.
        expect(Math.abs(now.x - before.x) * now.scale).toBeLessThanOrEqual(1);
        expect(Math.abs(now.y - before.y) * now.scale).toBeLessThanOrEqual(1);
      };

      // Fit off: the zoom goes to 100 %, and the window moves.
      await page.getByRole("button", { name: /^Fit/ }).click();
      await page.waitForTimeout(100);
      const fitOff = await markerInWindow(page);
      if (!fitOff) throw new Error("The Next: marker went.");
      expect(fitOff.scale).not.toBeCloseTo(before.scale, 2);
      near(fitOff);

      // Fit on again, then drag the scene column splitter: the stage and the zoom change.
      await page.getByRole("button", { name: /^Fit/ }).click();
      const splitter = page.getByRole("separator", {
        name: "Scene column width",
      });
      await splitter.focus();
      for (let i = 0; i < 12; i++) await splitter.press("ArrowRight");
      await page.waitForTimeout(150);
      const dragged = await markerInWindow(page);
      if (!dragged) throw new Error("The Next: marker went.");
      near(dragged);
    } finally {
      await page.close();
    }
  }, 60_000);

  for (const reducedMotion of ["no-preference", "reduce"] as const) {
    test(`a warning hover that seeks back keeps the window covered until the target state (${reducedMotion})`, async () => {
      if (!browser) throw new Error("No browser.");
      const page = await browser.newPage({
        viewport: { width: 1600, height: 1000 },
        reducedMotion,
      });
      try {
        await openScene(page, "install-mac");
        // To the end of the run, so its warnings are found; a warning hover then seeks back.
        await page.evaluate(() => window.__workbenchPage?.seek(240_000));
        await page.waitForSelector(".wb-warning-list button");
        const rows = await page.evaluate(
          () =>
            [...document.querySelectorAll(".wb-warning-list button")].map(
              (b) => b.textContent ?? "",
            ).length,
        );
        expect(rows).toBeGreaterThan(1);

        // Each animation frame: is the window ready, is there a still, and its state.
        await page.evaluate(() => {
          const samples: {
            ready: boolean;
            still: boolean;
            stillLoaded: boolean;
            seeking: boolean;
            highlight: boolean;
          }[] = [];
          (window as unknown as { __samples: typeof samples }).__samples =
            samples;
          const tick = () => {
            const still = document.querySelector<HTMLIFrameElement>(
              "[data-workbench-still]",
            );
            samples.push({
              ready: window.__workbenchPage?.ready === true,
              still: still !== null,
              stillLoaded:
                (still?.contentDocument?.body?.childElementCount ?? 0) > 0,
              seeking: /Seeking to/.test(
                document.querySelector(".wb-warnings h3")?.textContent ?? "",
              ),
              highlight:
                document.querySelector("[data-workbench-highlight]") !== null,
            });
            requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        });
        const rowCount = await page.evaluate(
          () => document.querySelectorAll(".wb-warning-list li").length,
        );
        // The first row is the earliest warning: a seek back from the end.
        await page.locator(".wb-warning-list button").first().hover();
        await page.waitForSelector("[data-workbench-highlight]");
        await page.waitForTimeout(100);
        const samples = await page.evaluate(
          () =>
            (
              window as unknown as {
                __samples: {
                  ready: boolean;
                  still: boolean;
                  stillLoaded: boolean;
                  seeking: boolean;
                  highlight: boolean;
                }[];
              }
            ).__samples,
        );
        // The window started again (a seek back): there were frames where it was not ready.
        const replaying = samples.filter((s) => !s.ready);
        expect(replaying.length).toBeGreaterThan(0);
        // In each of them, a loaded still covered it.
        for (const s of replaying) {
          expect(s.still).toBe(true);
          expect(s.stillLoaded).toBe(true);
        }
        // The still goes in the same frame the warning shows: never a frame with neither.
        const first = samples.findIndex((s) => s.highlight);
        expect(first).toBeGreaterThan(0);
        for (const s of samples.slice(0, first)) {
          if (s.seeking) expect(s.still || s.ready).toBe(true);
        }
        expect(samples[first]?.still).toBe(false);
        // The list did not shrink under the pointer.
        expect(
          await page.evaluate(
            () => document.querySelectorAll(".wb-warning-list li").length,
          ),
        ).toBe(rowCount);
      } finally {
        await page.close();
      }
    }, 120_000);
  }
});
