import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  ensureServer,
  HOOK_START_MS,
  HOOK_STOP_MS,
  sharedChromium,
} from "./server";
import { DEFAULT_WINDOW, encodeState } from "./urlState";

/**
 * The page's keys (Space, ".", "/", the arrows, C) do nothing while the focus is in a control that
 * uses the key itself: an app Select (closed or open), the Time slider, a Combobox, a popup. Base
 * UI draws these as a button, a div with an input in it, and a popup div, not as the native
 * fields, so this runs them in Chromium.
 *
 *   OPENBOT_APP_BROWSER=1 bun test workbench/keys.browser.test.ts
 */
const asked = process.env.OPENBOT_APP_BROWSER === "1";

// Playwright comes from the root install. See determinism.browser.test.ts.
const PLAYWRIGHT: string = "playwright-core";
type Box = { x: number; y: number; width: number; height: number };
type Locator = {
  first(): Locator;
  click(): Promise<void>;
  focus(): Promise<void>;
  fill(text: string): Promise<void>;
  inputValue(): Promise<string>;
  getAttribute(name: string): Promise<string | null>;
  isVisible(): Promise<boolean>;
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
  keyboard: {
    press(key: string): Promise<void>;
    type(text: string): Promise<void>;
  };
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

async function newPage(): Promise<Page> {
  if (!browser) throw new Error("No browser.");
  return browser.newPage({
    viewport: { width: 1280, height: 900 },
    reducedMotion: "reduce",
  });
}

/** install-mac at 0, paused: "." would step it, Space would play it. */
async function openScene(page: Page, scene = "install-mac"): Promise<void> {
  if (!server) throw new Error("No server.");
  const query = encodeState({
    scene,
    at: 0,
    answers: {},
    env: {},
    window: { ...DEFAULT_WINDOW, width: 1000, height: 800 },
  });
  await page.goto(`${server.url}/workbench/?${query}`);
  await page.waitForFunction(() => window.__workbenchPage?.ready === true);
}

/** What the page's keys could have changed. */
function seen(page: Page) {
  return page.evaluate(() => ({
    now: window.__workbenchPage?.now() ?? null,
    playing:
      document.querySelector("button[aria-keyshortcuts=Space]")?.textContent ??
      null,
    commenting:
      document
        .querySelector("button[aria-keyshortcuts=C]")
        ?.getAttribute("aria-pressed") ?? null,
    filterFocused:
      document.activeElement?.getAttribute("aria-label") === "Filter scenes",
  }));
}

/** Presses each key, then waits a little for anything it starts. */
async function press(page: Page, ...keys: string[]): Promise<void> {
  for (const key of keys) await page.keyboard.press(key);
  await page.waitForTimeout(300);
}

function windowBox(page: Page): Promise<Box> {
  return page.evaluate(() => {
    const frame = document.querySelector("[data-workbench-window] iframe");
    if (!frame) throw new Error("No window.");
    const r = frame.getBoundingClientRect();
    return { x: r.left, y: r.top, width: r.width, height: r.height };
  });
}

describe.skipIf(!asked)("the page's keys", () => {
  test("c, . and / do nothing on a focused Select; Space and Enter open it", async () => {
    const page = await newPage();
    try {
      await openScene(page);
      const before = await seen(page);
      const speed = page.getByRole("combobox", { name: "Speed" });
      await speed.focus();
      await press(page, "c", ".", "/");
      expect(await seen(page)).toEqual(before);

      await press(page, "Space");
      await page.locator("[role=listbox]").waitFor();
      expect(await seen(page)).toEqual(before);
      await press(page, "Escape");
      await page.locator("[role=listbox]").waitFor({ state: "hidden" });

      await speed.focus();
      await press(page, "Enter");
      await page.locator("[role=listbox]").waitFor();
      expect(await seen(page)).toEqual(before);

      // In the open list, the keys are the list's too.
      await press(page, "c", ".", "/");
      expect(await seen(page)).toEqual(before);
    } finally {
      await page.close();
    }
  }, 120_000);

  test("c in the Comment box's Ask for keeps the box and the typed comment", async () => {
    const page = await newPage();
    try {
      await openScene(page);
      const win = await windowBox(page);
      await page.getByRole("button", { name: "Comment", exact: true }).click();
      await page.mouse.move(win.x + 40, win.y + 200);
      await page.mouse.down();
      await page.mouse.move(win.x + 80, win.y + 240, { steps: 4 });
      await page.mouse.up();
      const box = page.getByRole("dialog", { name: "Comment" });
      await box.waitFor();
      await page.keyboard.type("Make the button bigger");
      const before = await seen(page);

      await page.getByRole("combobox", { name: "Ask for" }).focus();
      await press(page, "c", ".", "/");
      expect(await box.isVisible()).toBe(true);
      expect(
        await page
          .locator("[data-workbench-comment-popover] textarea")
          .inputValue(),
      ).toBe("Make the button bigger");
      expect(await seen(page)).toEqual(before);

      // The focus on the box itself, or on its Cancel button: the keys do nothing there either.
      await page.locator("[data-workbench-comment-popover]").focus();
      await press(page, "c", ".", "/", "Space");
      expect(await box.isVisible()).toBe(true);
      expect(await seen(page)).toEqual(before);
      await page.getByRole("button", { name: "Cancel" }).focus();
      await press(page, "c", ".", "/");
      expect(await box.isVisible()).toBe(true);
      expect(await seen(page)).toEqual(before);
    } finally {
      await page.close();
    }
  }, 120_000);

  test("the focused Time slider keeps its arrows; . and / do nothing", async () => {
    const page = await newPage();
    try {
      await openScene(page);
      const time = page.getByRole("slider", { name: "Time" });
      await time.focus();
      await press(page, "ArrowRight");
      const after = await seen(page);
      // The slider's own step (100 ms), not the page's 1 s.
      expect(after.now).toBe(100);
      await press(page, ".", "/", "c", "Space");
      expect(await seen(page)).toEqual(after);
    } finally {
      await page.close();
    }
  }, 120_000);

  test("Space and . do nothing on the keys help popup", async () => {
    const page = await newPage();
    try {
      await openScene(page);
      const before = await seen(page);
      await page.getByRole("button", { name: "Keys" }).click();
      const popup = page.getByRole("dialog", { name: "Keys" });
      await popup.waitFor();
      await popup.focus();
      await press(page, "Space", ".", "/");
      expect(await seen(page)).toEqual(before);
    } finally {
      await page.close();
    }
  }, 120_000);

  for (const leave of ["Tab", "click"] as const) {
    test(`a typed route not in the list stays after a ${leave}, for Set answer`, async () => {
      const page = await newPage();
      try {
        await openScene(page, "app-home-bots");
        await page.getByRole("button", { name: "API answers" }).click();
        const route = page.getByRole("combobox", { name: "Route" });
        await route.click();
        const typed = "GET /api/v2/not-in-the-list";
        await page.keyboard.type(typed);
        await page.waitForTimeout(200);
        if (leave === "Tab") await press(page, "Tab");
        else {
          const label = await page.evaluate(() => {
            const r = document
              .querySelector("aside:last-of-type")
              ?.getBoundingClientRect();
            return r ? { x: r.left + 8, y: r.bottom - 8 } : null;
          });
          if (!label) throw new Error("No right column.");
          await page.mouse.click(label.x, label.y);
          await page.waitForTimeout(300);
        }
        expect(await route.inputValue()).toBe(typed);
        await page.getByRole("button", { name: "Set answer" }).click();
        await page.waitForTimeout(200);
        expect(await route.inputValue()).toBe(typed);
        // The scene sets its own answers; the typed route is one more.
        expect(
          await page.evaluate(() =>
            [...document.querySelectorAll("[data-testid=api-answer] code")].map(
              (code) => code.textContent,
            ),
          ),
        ).toContain(typed);
      } finally {
        await page.close();
      }
    }, 120_000);
  }
});
