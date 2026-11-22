import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ensureServer } from "./server";

/**
 * An app scene in the workbench page: the app frame shows the app's screen when the page reports
 * ready, runs on the fakes from the same origin, loads one time only, and nothing in the page or
 * the frame gets a 404.
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
  evaluate<T, A = undefined>(run: (arg: A) => T, arg?: A): Promise<T>;
  addInitScript(run: () => void): Promise<void>;
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

declare global {
  interface Window {
    /** The number of "load" events of the page's frames, set by this test's init script. */
    __testFrameLoads?: number;
  }
}

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

async function openPage(): Promise<Page> {
  if (!browser || !server) throw new Error("No browser or server.");
  return browser.newPage({ viewport: { width: 1800, height: 1200 } });
}

async function waitReady(page: Page): Promise<void> {
  await page.waitForFunction(() => window.__workbenchPage?.ready === true);
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
      await waitReady(page);
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

  test("the app frame boots on the fakes, same origin", async () => {
    if (!server) throw new Error("No server.");
    const page = await openPage();
    try {
      await page.goto(`${server.url}/workbench/?scene=app-home-bots`);
      await waitReady(page);
      await page.evaluate(() => window.__workbenchPage?.seek(3000));
      const info = await page.evaluate(() => {
        const iframe = document.querySelector("iframe");
        const doc = iframe?.contentDocument ?? null;
        const workbench = window.__workbenchPage;
        return {
          readable: doc !== null,
          titlebar: doc?.documentElement.dataset.desktopTitlebar ?? null,
          unanswered: (workbench?.requests() ?? [])
            .filter((r) => r.source === "none")
            .map((r) => `${r.method} ${r.path}`),
          connection: (workbench?.calls() ?? [])
            .filter((c) => c.command === "plugin:openbot-desktop|connection")
            .map((c) => c.known),
          errors: [...(workbench?.errors() ?? [])],
        };
      });
      expect(info.readable).toBe(true);
      // The Mac page script of OpenBot Desktop ran in the frame.
      expect(info.titlebar).toBe("overlay");
      expect(info.unanswered).toEqual([]);
      expect(info.connection.length).toBeGreaterThan(0);
      expect(info.connection.every((known) => known)).toBe(true);
      expect(info.errors).toEqual([]);
    } finally {
      await page.close();
    }
  }, 120_000);

  test("no reload after the first load, and the HMR socket connects", async () => {
    if (!server) throw new Error("No server.");
    const page = await openPage();
    // Count the "load" events of each frame the page adds, from the time it is in the document.
    await page.addInitScript(() => {
      if (window.parent !== window) return;
      window.__testFrameLoads = 0;
      const watched = new WeakSet<HTMLIFrameElement>();
      const watch = () => {
        for (const iframe of document.querySelectorAll("iframe")) {
          if (watched.has(iframe)) continue;
          watched.add(iframe);
          iframe.addEventListener("load", () => {
            window.__testFrameLoads = (window.__testFrameLoads ?? 0) + 1;
          });
        }
      };
      new MutationObserver(watch).observe(document, {
        childList: true,
        subtree: true,
      });
    });
    const socketProblems: string[] = [];
    page.on("console", (message) => {
      const text = message.text();
      if (
        text.includes("failed to connect to websocket") ||
        text.includes("[vite] server connection lost")
      )
        socketProblems.push(text);
    });
    try {
      await page.goto(`${server.url}/workbench/?scene=app-home-bots`);
      await waitReady(page);
      await page.evaluate(() => window.__workbenchPage?.seek(5000));
      const loads = await page.evaluate(() => window.__testFrameLoads);
      expect(loads).toBe(1);
      expect(socketProblems).toEqual([]);
    } finally {
      await page.close();
    }
  }, 120_000);

  test("an API answer and a route change", async () => {
    if (!server) throw new Error("No server.");
    const page = await openPage();
    try {
      await page.goto(`${server.url}/workbench/?scene=app-home-bots`);
      await waitReady(page);
      const start = await page.evaluate(() => window.__workbenchPage?.now());
      await appFrame(page).evaluate(() => {
        window.__workbenchApi?.setAnswer(
          "GET /api/v2/organizations/:organizationId/bots",
          { mode: "value", body: { bots: [], nextCursor: null } },
        );
        // What a navigate step does.
        history.pushState(null, "", "/settings");
        dispatchEvent(new PopStateEvent("popstate"));
      });
      await page.evaluate(
        (ms) => window.__workbenchPage?.seek(ms),
        (start ?? 0) + 1000,
      );
      const after = await appFrame(page).evaluate(() => ({
        path: location.pathname,
        heading: document.querySelector("h1, h2, [role=heading]") !== null,
        bots: (window.__workbenchApi?.requests() ?? [])
          .filter(
            (r) => r.route === "GET /api/v2/organizations/:organizationId/bots",
          )
          .map((r) => r.source),
      }));
      expect(after.path).toBe("/settings");
      expect(after.heading).toBe(true);
      // The answer set above is newer than any request made before it.
      const newest = after.bots.at(-1);
      if (newest !== undefined) expect(newest).toBe("answer");
    } finally {
      await page.close();
    }
  }, 120_000);

  test("a delayed answer before the first screen still boots the frame", async () => {
    if (!server) throw new Error("No server.");
    const route = "GET /api/v2/people/me/organizations";
    const page = await openPage();
    try {
      // The answer the scene gives at once, to give it again after a delay.
      await page.goto(`${server.url}/workbench/?scene=app-home-bots`);
      await waitReady(page);
      const body = await appFrame(page).evaluate(() =>
        fetch("/api/v2/people/me/organizations").then((r) => r.json()),
      );
      // The app waits for this answer before it draws, and the delay runs on the paused clock.
      const api = JSON.stringify({ [route]: { mode: "delay", ms: 500, body } });
      await page.goto(
        `${server.url}/workbench/?scene=app-home-bots&api=${encodeURIComponent(api)}`,
      );
      await waitReady(page);
      await page.evaluate(() => window.__workbenchPage?.seek(1500));
      // The fetch and the renders after the delay run on real time, so read the text when the
      // screen has drawn (up to 5 s).
      const frame = appFrame(page);
      let text = "";
      for (let i = 0; i < 50 && !text.includes("Start a conversation"); i++) {
        text = await frame.evaluate(() => document.body.innerText.trim());
        if (!text.includes("Start a conversation"))
          await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(text).not.toBe("");
      expect(text).toContain("Start a conversation");
    } finally {
      await page.close();
    }
  }, 120_000);

  test("the browser host has no Desktop bridge", async () => {
    if (!server) throw new Error("No server.");
    const page = await openPage();
    try {
      await page.goto(
        `${server.url}/workbench/?scene=app-home-bots&host=browser`,
      );
      await waitReady(page);
      const frame = await appFrame(page).evaluate(() => ({
        bridge:
          (window as unknown as { __TAURI_INTERNALS__?: unknown })
            .__TAURI_INTERNALS__ !== undefined,
        titlebar: document.documentElement.hasAttribute(
          "data-desktop-titlebar",
        ),
      }));
      expect(frame).toEqual({ bridge: false, titlebar: false });
      const browserBar = await page.evaluate(
        () =>
          document.querySelector(
            "[data-workbench-window] .wb-window-bar-browser",
          ) !== null,
      );
      expect(browserBar).toBe(true);
    } finally {
      await page.close();
    }
  }, 120_000);

  test("the desktop frame still loads", async () => {
    if (!server) throw new Error("No server.");
    const page = await openPage();
    try {
      await page.goto(`${server.url}/workbench/?scene=install-mac`);
      await waitReady(page);
      const info = await page.evaluate(() => ({
        kind: window.__workbenchPage?.kind,
        path: document.querySelector("iframe")?.contentWindow?.location
          .pathname,
      }));
      expect(info).toEqual({ kind: "desktop", path: "/workbench/frame.html" });
    } finally {
      await page.close();
    }
  }, 120_000);
});
