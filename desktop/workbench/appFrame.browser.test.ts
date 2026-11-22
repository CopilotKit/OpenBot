import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ensureServer } from "./server";

/**
 * An app scene in the workbench page: the app frame shows the app's screen when the page reports
 * ready, and nothing in the page or the frame gets a 404.
 *
 *   OPENBOT_APP_BROWSER=1 bun test workbench/appFrame.browser.test.ts
 */
const asked = process.env.OPENBOT_APP_BROWSER === "1";

// Playwright comes from the root install, so the module is named by a variable (see
// determinism.browser.test.ts) and only the part used here is typed.
const PLAYWRIGHT: string = "playwright-core";
type Frame = { evaluate<T>(run: () => T): Promise<T> };
type Response = { status(): number; url(): string };
type ConsoleMessage = {
  type(): string;
  text(): string;
  location(): { url: string };
};
type Page = {
  goto(url: string): Promise<unknown>;
  waitForFunction(run: () => unknown): Promise<unknown>;
  evaluate<T>(run: () => T): Promise<T>;
  frames(): Frame[];
  mainFrame(): Frame;
  on(event: "console", handler: (message: ConsoleMessage) => void): void;
  on(event: "response", handler: (response: Response) => void): void;
  on(event: "pageerror", handler: (error: Error) => void): void;
  close(): Promise<void>;
};
type Browser = {
  newPage(options: {
    viewport: { width: number; height: number };
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

function appFrame(page: Page): Frame {
  const frame = page.frames().find((f) => f !== page.mainFrame());
  if (!frame) throw new Error("The workbench has no app frame.");
  return frame;
}

describe.skipIf(!asked)("the app frame in the workbench page", () => {
  test("app-home-bots shows the Home screen when the page is ready", async () => {
    if (!browser || !server) throw new Error("No browser or server.");
    const page = await browser.newPage({
      viewport: { width: 1600, height: 1000 },
    });
    // Each failed load: a response the page sees, and the console line of a load that the
    // response event does not report (the browser's own favicon request, for example).
    const failed: string[] = [];
    page.on("response", (response) => {
      if (response.status() >= 400)
        failed.push(`${response.status()} ${response.url()}`);
    });
    page.on("console", (message) => {
      if (
        message.type() === "error" &&
        message.text().startsWith("Failed to load resource")
      )
        failed.push(`${message.text()} ${message.location().url}`);
    });
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    try {
      await page.goto(`${server.url}/workbench/?scene=app-home-bots`);
      await page.waitForFunction(() => window.__workbenchPage?.ready === true);
      const info = await page.evaluate(() => ({
        kind: window.__workbenchPage?.kind,
        errors: window.__workbenchPage?.errors() ?? [],
      }));
      expect(info).toEqual({ kind: "app", errors: [] });

      // Read at ready, with no wait: ready means the app drew its screen.
      const shot = await appFrame(page).evaluate(() => ({
        path: location.pathname,
        text: document.body.innerText,
      }));
      expect(shot.path).toBe("/");
      expect(shot.text).toContain("Start a conversation");
      expect(shot.text).toContain("General Assistant");
      expect(failed).toEqual([]);
      expect(pageErrors).toEqual([]);
    } finally {
      await page.close();
    }
  }, 120_000);
});
