import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Warning } from "./layoutWatch";
import { ensureServer } from "./server";
import { DEFAULT_WINDOW, encodeState } from "./urlState";
import { warningText } from "./WarningsList";

/**
 * The workbench watches the window's layout as it runs: what moved, what is cut off, and what is
 * outside the window. These tests run the watch in a real browser.
 *
 *   OPENBOT_APP_BROWSER=1 bun test workbench/layoutWatch.browser.test.ts
 */
const asked = process.env.OPENBOT_APP_BROWSER === "1";

/*
 * Playwright comes from the root install. The desktop's own jobs typecheck this file without it,
 * so the module is named by a variable and only the part used here is typed.
 */
const PLAYWRIGHT: string = "playwright-core";
type Locator = {
  click(): Promise<void>;
  waitFor(options?: { state?: "visible" | "hidden" }): Promise<void>;
};
type Frame = {
  evaluate<T>(run: () => T): Promise<T>;
  getByRole(role: string, options: { name: string; exact?: boolean }): Locator;
  getByText(text: string): Locator;
  getByLabel(text: string, options?: { exact?: boolean }): Locator;
};
type Page = {
  goto(url: string): Promise<unknown>;
  waitForFunction(run: () => unknown): Promise<unknown>;
  waitForTimeout(ms: number): Promise<void>;
  evaluate<T, A = undefined>(
    run: ((arg: A) => T) | string,
    arg?: A,
  ): Promise<T>;
  frames(): Frame[];
  mainFrame(): Frame;
  close(): Promise<void>;
};
type Browser = {
  newPage(options: {
    viewport: { width: number; height: number };
    reducedMotion?: "reduce" | "no-preference";
  }): Promise<Page>;
  close(): Promise<void>;
};
type Chromium = { launch(options: { channel: string }): Promise<Browser> };

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

async function openScene(page: Page, scene: string): Promise<void> {
  if (!server) throw new Error("No server.");
  const query = encodeState({
    scene,
    at: 0,
    answers: {},
    env: {},
    window: DEFAULT_WINDOW,
  });
  await page.goto(`${server.url}/workbench/?${query}`);
  await page.waitForFunction(() => window.__workbenchPage?.ready === true);
}

function warningsOf(page: Page): Promise<Warning[]> {
  return page.evaluate(() => window.__workbenchPage?.warnings() ?? []);
}

describe.skipIf(!asked)("the workbench's layout watch", () => {
  test("the AI step's form does not move as the download behind it comes and goes", async () => {
    if (!browser) throw new Error("No browser.");
    // CSS animations run on real time. Reduced motion turns them off, so an entrance is not a move.
    const page = await browser.newPage({
      viewport: { width: 1600, height: 1000 },
      reducedMotion: "reduce",
    });
    try {
      // At 0 and with no run, the window's clock plays at 1×.
      await openScene(page, "state-first-run");
      const frame = windowFrame(page);
      await frame.getByRole("button", { name: "Install", exact: true }).click();
      await frame.getByRole("heading", { name: "Connect your AI" }).waitFor();
      await frame.getByText("Any OpenAI-compatible endpoint").click();
      await frame.getByLabel("Base URL", { exact: true }).waitFor();
      await page.waitForTimeout(600);

      await frame.evaluate(() => {
        (
          globalThis as unknown as { __fake: { download: unknown } }
        ).__fake.download = { done: 400_000_000, total: 1_600_000_000 };
      });
      await frame.getByText("400.0 MB of 1.6 GB").waitFor();
      await frame.evaluate(() => {
        (
          globalThis as unknown as { __fake: { download: unknown } }
        ).__fake.download = null;
      });
      await frame.getByText("400.0 MB of 1.6 GB").waitFor({ state: "hidden" });
      await frame.evaluate(() =>
        (
          globalThis as unknown as { __fake: { finishSetUp: () => void } }
        ).__fake.finishSetUp(),
      );
      await frame.getByText("OpenBot is installed").waitFor();
      // One more frame, so the last change is checked.
      await page.waitForTimeout(100);

      const warnings = await warningsOf(page);
      console.log(
        `state-first-run, the AI step: ${warnings.length} warnings\n${warnings.map(warningText).join("\n")}`,
      );
      const moved = warnings.filter(
        (w) => w.kind === "moved" && w.label.includes("Base URL"),
      );
      expect(moved).toEqual([]);
    } finally {
      await page.close();
    }
  }, 60_000);

  test("text in a narrow box that does not wrap is cut off", async () => {
    if (!browser) throw new Error("No browser.");
    const page = await browser.newPage({
      viewport: { width: 800, height: 600 },
    });
    try {
      await openScene(page, "state-first-run");
      // A string, so the import runs in the page as written.
      const kinds = await page.evaluate<string[]>(`(async () => {
        const box = document.createElement("div");
        box.style.cssText = "width: 100px; white-space: nowrap; overflow: hidden;";
        box.textContent = "This is a long line of text that does not fit in its box";
        const body = document.createElement("body");
        body.append(box);
        document.body.replaceWith(body);
        const { clippedAndOutside } = await import("/workbench/layoutWatch.ts");
        return clippedAndOutside(document, 0, { width: innerWidth, height: innerHeight })
          .map((warning) => warning.kind);
      })()`);
      expect(kinds).toContain("clipped");
    } finally {
      await page.close();
    }
  }, 30_000);

  test("install-mac played to its end gives a list of warnings", async () => {
    if (!browser) throw new Error("No browser.");
    const page = await browser.newPage({
      viewport: { width: 1600, height: 1000 },
      reducedMotion: "reduce",
    });
    try {
      await openScene(page, "install-mac");
      const end = await windowFrame(page).evaluate(
        () => globalThis.__workbenchRunInfo?.end ?? 0,
      );
      expect(end).toBeGreaterThan(0);
      await page.evaluate((ms) => window.__workbenchPage?.seek(ms), end);
      const warnings = await warningsOf(page);
      // Real data to read, not a count to hold.
      console.log(
        `install-mac to ${end} ms: ${warnings.length} warnings\n${warnings.map(warningText).join("\n")}`,
      );
      expect(Array.isArray(warnings)).toBe(true);
    } finally {
      await page.close();
    }
  }, 180_000);
});
