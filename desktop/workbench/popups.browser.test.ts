import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  ensureServer,
  HOOK_START_MS,
  HOOK_STOP_MS,
  sharedChromium,
} from "./server";
import { DEFAULT_WINDOW, encodeState } from "./urlState";

/**
 * The app's popups (Select, Popover, Tooltip) are portals on the page's body. They show above the
 * window and the tools over it, and Comment mode and the inspector do not take them for a part of
 * the window (README, "Comment mode").
 *
 *   OPENBOT_APP_BROWSER=1 bun test workbench/popups.browser.test.ts
 */
const asked = process.env.OPENBOT_APP_BROWSER === "1";

// Playwright comes from the root install. See determinism.browser.test.ts.
const PLAYWRIGHT: string = "playwright-core";
type Box = { x: number; y: number; width: number; height: number };
type Locator = {
  first(): Locator;
  click(): Promise<void>;
  boundingBox(): Promise<Box | null>;
  waitFor(options?: {
    state?: "attached" | "visible" | "hidden" | "detached";
  }): Promise<void>;
};
type Page = {
  goto(url: string): Promise<unknown>;
  waitForFunction(run: () => unknown): Promise<unknown>;
  waitForTimeout(ms: number): Promise<void>;
  evaluate<T, A = undefined>(
    run: ((arg: A) => T) | string,
    arg?: A,
  ): Promise<T>;
  locator(selector: string): Locator;
  getByRole(role: string, options: { name: string; exact?: boolean }): Locator;
  mouse: {
    move(x: number, y: number, options?: { steps?: number }): Promise<void>;
    click(x: number, y: number): Promise<void>;
    down(): Promise<void>;
    up(): Promise<void>;
  };
  keyboard: { press(key: string): Promise<void> };
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

/*
 * install-mac has run steps, so the Run panel shows the speed Select. The window is wider than the
 * stage, so its right part lies under the right column, where the Select's list opens.
 */
async function openScene(page: Page): Promise<void> {
  if (!server) throw new Error("No server.");
  const query = encodeState({
    scene: "install-mac",
    at: 0,
    answers: {},
    env: {},
    window: { ...DEFAULT_WINDOW, width: 1000, height: 800 },
  });
  await page.goto(`${server.url}/workbench/?${query}`);
  await page.waitForFunction(() => window.__workbenchPage?.ready === true);
}

function windowBox(page: Page): Promise<Box> {
  return page.evaluate(() => {
    const frame = document.querySelector("[data-workbench-window] iframe");
    if (!frame) throw new Error("No window.");
    const r = frame.getBoundingClientRect();
    return { x: r.left, y: r.top, width: r.width, height: r.height };
  });
}

/** The middle of the part of `box` that lies over `under`, or null when they do not meet. */
function overlap(box: Box, under: Box): { x: number; y: number } | null {
  const left = Math.max(box.x, under.x);
  const right = Math.min(box.x + box.width, under.x + under.width);
  const top = Math.max(box.y, under.y);
  const bottom = Math.min(box.y + box.height, under.y + under.height);
  if (right - left < 4 || bottom - top < 4) return null;
  return { x: (left + right) / 2, y: (top + bottom) / 2 };
}

/** The option named `name` (or the first one) that lies over the window, and the point to use. */
async function optionOverWindow(
  page: Page,
  win: Box,
  name?: string,
): Promise<{ text: string; x: number; y: number }> {
  await page.locator("[role=option]").first().waitFor();
  const options = await page.evaluate(() =>
    [...document.querySelectorAll("[role=option]")].map((option) => {
      const r = option.getBoundingClientRect();
      return {
        text: option.textContent ?? "",
        box: { x: r.left, y: r.top, width: r.width, height: r.height },
      };
    }),
  );
  for (const option of options) {
    if (name !== undefined && option.text !== name) continue;
    const point = overlap(option.box, win);
    if (point) return { text: option.text, ...point };
  }
  throw new Error(`No option over the window: ${JSON.stringify(options)}`);
}

/** The text of the option on top at a point of the page, or null when no option is on top. */
function optionOnTop(page: Page, point: { x: number; y: number }) {
  return page.evaluate(
    ({ x, y }) =>
      document.elementFromPoint(x, y)?.closest("[role=option]")?.textContent ??
      null,
    point,
  );
}

describe.skipIf(!asked)("popups over the window", () => {
  test("a Select popup over the window is above it and is not inspected", async () => {
    if (!browser) throw new Error("No browser.");
    const page = await browser.newPage({
      viewport: { width: 1280, height: 900 },
      reducedMotion: "reduce",
    });
    try {
      await openScene(page);
      const win = await windowBox(page);
      // The inspector is on: over the window, it shows a box.
      await page.mouse.move(win.x + 100, win.y + 300);
      await page
        .locator("[data-workbench-inspector]")
        .waitFor({ state: "attached" });

      await page.getByRole("combobox", { name: "Speed" }).click();
      const option = await optionOverWindow(page, win);
      await page.mouse.move(option.x, option.y, { steps: 8 });
      expect(await optionOnTop(page, option)).toBe(option.text);
      // A few frames for the inspector, which measures on an animation frame.
      await page.waitForTimeout(200);
      expect(
        await page.evaluate(
          () => document.querySelector("[data-workbench-inspector]") !== null,
        ),
      ).toBe(false);
    } finally {
      await page.close();
    }
  }, 120_000);

  test("a click in a popup in Comment mode does not start a comment", async () => {
    if (!browser) throw new Error("No browser.");
    const page = await browser.newPage({
      viewport: { width: 1280, height: 900 },
      reducedMotion: "reduce",
    });
    try {
      await openScene(page);
      const win = await windowBox(page);
      await page.getByRole("button", { name: "Comment", exact: true }).click();
      // A small area near the window's left edge, so the box opens beside it, over the window.
      await page.mouse.move(win.x + 40, win.y + 200);
      await page.mouse.down();
      await page.mouse.move(win.x + 80, win.y + 240, { steps: 4 });
      await page.mouse.up();
      const box = page.getByRole("dialog", { name: "Comment" });
      await box.waitFor();
      const picked = () =>
        page.evaluate(() => {
          const outline = document.querySelector(
            "[data-workbench-comment-selected]",
          );
          const r = outline?.getBoundingClientRect();
          return {
            outline: r ? [r.left, r.top, r.width, r.height] : null,
            target:
              document.querySelector("[data-workbench-comment-popover] div")
                ?.textContent ?? null,
            drag: document.querySelector("[data-workbench-comment-drag]")
              ? "drag"
              : null,
          };
        });
      const first = await picked();
      expect(first.outline).not.toBeNull();

      // The comment box's own list opens over the window; a click on an option picks the option.
      await page.getByRole("combobox", { name: "Ask for" }).click();
      const option = await optionOverWindow(page, win, "Typeset (impeccable)");
      expect(await optionOnTop(page, option)).toBe(option.text);
      await page.mouse.click(option.x, option.y);
      await page.locator("[role=option]").first().waitFor({ state: "hidden" });
      await box.waitFor();
      expect(
        await page.evaluate(
          () =>
            document.querySelector(
              "[data-workbench-comment-popover] [data-slot=select-trigger]",
            )?.textContent,
        ),
      ).toContain("Typeset (impeccable)");
      expect(await picked()).toEqual(first);

      // A click in the box, over the window, does not pick again either.
      const text = await page
        .getByRole("textbox", { name: "Anything to add? (optional)" })
        .boundingBox();
      if (!text) throw new Error("No comment field.");
      expect(overlap(text, win)).not.toBeNull();
      await page.mouse.click(text.x + 8, text.y + 8);
      await page.waitForTimeout(200);
      expect(await picked()).toEqual(first);
    } finally {
      await page.close();
    }
  }, 120_000);
});
