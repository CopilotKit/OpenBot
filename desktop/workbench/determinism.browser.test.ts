import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PLAN_CODE } from "./scenes/install";
import { ensureServer } from "./server";
import { DEFAULT_WINDOW, encodeState } from "./urlState";

/**
 * A scene at a time looks the same each way you get there: opened at that time, seeked back and
 * forward to it, and reloaded. The workbench's clock runs the window's timers and the scene's run
 * in time order, so the same time gives the same window.
 *
 *   OPENBOT_APP_BROWSER=1 bun test workbench/determinism.browser.test.ts
 */
const asked = process.env.OPENBOT_APP_BROWSER === "1";

/*
 * Playwright comes from the root install. The desktop's own jobs typecheck this file without it,
 * so the module is named by a variable and only the part used here is typed.
 */
const PLAYWRIGHT: string = "playwright-core";
type Frame = {
  evaluate<T>(run: () => T): Promise<T>;
};
type Page = {
  goto(url: string): Promise<unknown>;
  reload(): Promise<unknown>;
  waitForFunction(run: () => unknown): Promise<unknown>;
  evaluate<T, A = undefined>(run: (arg: A) => T, arg?: A): Promise<T>;
  frames(): Frame[];
  mainFrame(): Frame;
  on(event: "console", handler: (message: ConsoleMessage) => void): void;
  close(): Promise<void>;
};
type ConsoleMessage = { type(): string; text(): string };
type Browser = {
  newPage(options: {
    viewport: { width: number; height: number };
    reducedMotion?: "reduce" | "no-preference";
  }): Promise<Page>;
  close(): Promise<void>;
};
type Chromium = { launch(options: { channel: string }): Promise<Browser> };

type Shot = { text: string; headings: string[]; boxes: string[] };

let browser: Browser | undefined;
let server: { url: string; stop(): Promise<void> } | undefined;

beforeAll(async () => {
  if (!asked) return;
  server = await ensureServer();
  const { chromium } = (await import(PLAYWRIGHT)) as { chromium: Chromium };
  browser = await chromium.launch({ channel: "chromium" });
});

afterAll(async () => {
  await browser?.close();
  await server?.stop();
});

function windowFrame(page: Page): Frame {
  const frame = page.frames().find((f) => f !== page.mainFrame());
  if (!frame) throw new Error("The workbench has no window frame.");
  return frame;
}

async function waitReady(page: Page): Promise<void> {
  await page.waitForFunction(() => window.__workbenchPage?.ready === true);
  // One frame after ready, as `seek` waits.
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(resolve)),
  );
}

/** The window's text and where each control and heading is, rounded to the pixel. */
async function read(page: Page): Promise<Shot> {
  return windowFrame(page).evaluate(() => {
    const selector = "[role], button, a, h1, h2, h3, h4, h5, h6, input";
    const boxes = [...document.querySelectorAll(selector)].map((el) => {
      const r = el.getBoundingClientRect();
      const name = el.getAttribute("role") ?? el.tagName.toLowerCase();
      return `${name} ${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.width)}x${Math.round(r.height)}`;
    });
    const headings = [
      ...document.querySelectorAll("h1, h2, h3, h4, h5, h6, [role=heading]"),
    ].map((el) => (el.textContent ?? "").trim());
    return { text: document.body.innerText, headings, boxes };
  });
}

describe.skipIf(!asked)("the workbench clock", () => {
  test("install-mac at 52 s is the same opened, seeked and reloaded", async () => {
    if (!browser || !server) throw new Error("No browser or server.");
    // CSS animations run on real time, not on the page clock. The window turns them off for
    // reduced motion, so each read sees the end of an entrance and not a point in it.
    const page = await browser.newPage({
      viewport: { width: 1600, height: 1000 },
      reducedMotion: "reduce",
    });
    // A run step that finds nothing on the page says so with "Run step:".
    const missed: string[] = [];
    page.on("console", (message) => {
      if (message.text().startsWith("Run step:")) missed.push(message.text());
    });
    const query = encodeState({
      scene: "install-mac",
      at: 52,
      answers: {},
      env: {},
      window: DEFAULT_WINDOW,
    });
    try {
      await page.goto(`${server.url}/workbench/?${query}`);
      await waitReady(page);
      const opened = await read(page);

      await page.evaluate(() => window.__workbenchPage?.seek(10_000));
      await page.evaluate(() => window.__workbenchPage?.seek(52_000));
      const seeked = await read(page);

      await page.reload();
      await waitReady(page);
      const reloaded = await read(page);

      expect(seeked).toEqual(opened);
      expect(reloaded).toEqual(opened);
      // The run went on from the first screen.
      expect(opened.headings).not.toContain("Set up OpenBot");
      expect(missed).toEqual([]);
    } finally {
      await page.close();
    }
  }, 60_000);

  test("install-anthropic-plan's type step fills the code field in the real window", async () => {
    if (!browser || !server) throw new Error("No browser or server.");
    const page = await browser.newPage({
      viewport: { width: 1600, height: 1000 },
      reducedMotion: "reduce",
    });
    const missed: string[] = [];
    page.on("console", (message) => {
      if (message.text().startsWith("Run step:")) missed.push(message.text());
    });
    const query = encodeState({
      scene: "install-anthropic-plan",
      at: 0,
      answers: {},
      env: {},
      window: DEFAULT_WINDOW,
    });
    try {
      await page.goto(`${server.url}/workbench/?${query}`);
      await waitReady(page);
      // Just after the type step, before Finish signing in.
      await page.evaluate(
        (ms) => window.__workbenchPage?.seek(ms),
        PLAN_CODE * 1000 + 1500,
      );
      const shot = await read(page);
      expect(shot.text).toContain("Code from your browser");
      const value = await windowFrame(page).evaluate(() => {
        for (const label of document.querySelectorAll("label")) {
          if (!(label.textContent ?? "").includes("Code from your browser"))
            continue;
          const id = label.getAttribute("for");
          const field = (
            id ? document.getElementById(id) : label.querySelector("input")
          ) as HTMLInputElement | null;
          if (field) return field.value;
        }
        return null;
      });
      expect(value).toBe("abc123#xyz");
      expect(missed).toEqual([]);
    } finally {
      await page.close();
    }
  }, 120_000);
});
