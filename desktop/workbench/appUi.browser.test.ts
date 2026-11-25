import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  ensureServer,
  HOOK_START_MS,
  HOOK_STOP_MS,
  sharedChromium,
} from "./server";

/**
 * The workbench page loads with the app's theme and one copy of React (README, "The rule").
 *
 *   OPENBOT_APP_BROWSER=1 bun test workbench/appUi.browser.test.ts
 */
const asked = process.env.OPENBOT_APP_BROWSER === "1";

// Playwright comes from the root install. Installed for the manual Workbench checks.
const PLAYWRIGHT: string = "playwright-core";
type Page = {
  goto(url: string): Promise<unknown>;
  waitForFunction(run: () => unknown): Promise<unknown>;
  evaluate<T>(run: () => T): Promise<T>;
  on(event: "console", handler: (message: { text(): string }) => void): void;
  close(): Promise<void>;
  getByRole(
    role: string,
    options: { name: string; exact?: boolean },
  ): {
    click(): Promise<void>;
    getAttribute(name: string): Promise<string | null>;
  };
};
type Browser = {
  newPage(options: {
    viewport: { width: number; height: number };
    colorScheme?: "light" | "dark";
  }): Promise<Page>;
};
type Chromium = { launch(options: { channel: string }): Promise<Browser> };

let browser: Browser | undefined;
let server: { url: string; stop(): Promise<void> } | undefined;

beforeAll(async () => {
  if (!asked) return;
  server = await ensureServer();
  const { chromium } = (await import(PLAYWRIGHT)) as { chromium: Chromium };
  browser = await sharedChromium(() =>
    chromium.launch({ channel: "chromium" }),
  );
}, HOOK_START_MS);

afterAll(async () => {
  await server?.stop();
}, HOOK_STOP_MS);

describe.skipIf(!asked)("the workbench page", () => {
  for (const scheme of ["light", "dark"] as const) {
    test(`loads with the app's ${scheme} theme and one React`, async () => {
      if (!browser || !server) throw new Error("No browser or server.");
      const page = await browser.newPage({
        viewport: { width: 1600, height: 1000 },
        colorScheme: scheme,
      });
      const errors: string[] = [];
      page.on("console", (message) => {
        const text = message.text();
        if (/Invalid hook call|more than one copy of React/.test(text))
          errors.push(text);
      });
      try {
        await page.goto(`${server.url}/workbench/`);
        await page.waitForFunction(
          () => window.__workbenchPage?.ready === true,
        );
        const seen = await page.evaluate(() => {
          // The app's --background, as the browser computes a color from it.
          const probe = document.createElement("div");
          probe.style.backgroundColor = "var(--background)";
          document.body.append(probe);
          const token = getComputedStyle(probe).backgroundColor;
          probe.remove();
          return {
            dark: document.documentElement.classList.contains("dark"),
            token,
            body: getComputedStyle(document.body).backgroundColor,
          };
        });
        expect(seen.dark).toBe(scheme === "dark");
        expect(seen.token).not.toBe("rgba(0, 0, 0, 0)");
        expect(seen.body).toBe(seen.token);
        expect(errors).toEqual([]);
      } finally {
        await page.close();
      }
    }, 60_000);
  }

  test("the columns stand on the app's surfaces, and a section opens from its trigger", async () => {
    if (!browser || !server) throw new Error("No browser or server.");
    const page = await browser.newPage({
      viewport: { width: 1600, height: 1000 },
    });
    try {
      await page.goto(`${server.url}/workbench/`);
      await page.waitForFunction(() => window.__workbenchPage?.ready === true);
      const seen = await page.evaluate(() => {
        const color = (value: string) => {
          const probe = document.createElement("div");
          probe.style.backgroundColor = value;
          document.body.append(probe);
          const computed = getComputedStyle(probe).backgroundColor;
          probe.remove();
          return computed;
        };
        const background = (el: Element | null) =>
          el ? getComputedStyle(el).backgroundColor : null;
        return {
          sidebar: color("var(--sidebar)"),
          ground: color("var(--background)"),
          columns: [...document.querySelectorAll("aside")].map(background),
          center: background(document.querySelector("main")),
        };
      });
      expect(seen.columns).toEqual([seen.sidebar, seen.sidebar]);
      expect(seen.center).toBe(seen.ground);

      await page.getByRole("button", { name: "Advanced", exact: true }).click();
      const calls = page.getByRole("button", { name: "Calls", exact: true });
      expect(await calls.getAttribute("data-slot")).toBe("collapsible-trigger");
      expect(await calls.getAttribute("aria-expanded")).toBe("false");
      await calls.click();
      expect(await calls.getAttribute("aria-expanded")).toBe("true");
    } finally {
      await page.close();
    }
  }, 60_000);
});
