import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  ensureServer,
  HOOK_START_MS,
  HOOK_STOP_MS,
  sharedChromium,
} from "./server";

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
type Frame = {
  evaluate<T>(run: () => T): Promise<T>;
  evaluate<T, A>(run: (arg: A) => T, arg: A): Promise<T>;
};
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

// The hooks name their time: bun gives a hook 5 s, and a server start or stop can take longer.
// bun test does not emit "exit", so stop() in afterAll is the only thing that gives the lease back.
// The browser is shared by the files of the run and is not closed here (see sharedChromium).
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
      // Read at once, with no wait: a seek resolves only when the frame is quiet, so the fetch
      // and the renders after the delay (on real time) are done.
      const text = await appFrame(page).evaluate(() =>
        document.body.innerText.trim(),
      );
      expect(text).not.toBe("");
      expect(text).toContain("Start a conversation");
    } finally {
      await page.close();
    }
  }, 120_000);

  // Motion asks for a draw only when its time moved, and the page clock stands still. Still
  // motion must still draw the final values, also of entrances with variants and staggered
  // children (sign) and of elements that mount late in a run (the conversation header).
  for (const [scene, selector, text] of [
    ["app-signed-out", "h1", "Sign in to OpenBot"],
    ["app-conversation-tools", "span", "Plan for today"],
  ] as const) {
    test(`still motion: in ${scene} at its end, "${text}" is drawn at its final values`, async () => {
      if (!server) throw new Error("No server.");
      const page = await openPage();
      try {
        await page.goto(`${server.url}/workbench/?scene=${scene}`);
        await waitReady(page);
        const end = await appFrame(page).evaluate(
          () => globalThis.__workbenchRunInfo?.end ?? 0,
        );
        await page.evaluate((ms) => window.__workbenchPage?.seek(ms), end);
        const found = await appFrame(page).evaluate(
          ([selector, text]) =>
            Array.from(document.querySelectorAll(selector))
              .filter((element) => element.textContent?.trim() === text)
              .map((element) => {
                const style = getComputedStyle(element);
                return { opacity: style.opacity, transform: style.transform };
              }),
          [selector, text],
        );
        expect(found.length).toBeGreaterThan(0);
        for (const style of found) {
          expect(style.opacity).toBe("1");
          expect(["none", "matrix(1, 0, 0, 1, 0, 0)"]).toContain(
            style.transform,
          );
        }
      } finally {
        await page.close();
      }
    }, 120_000);
  }

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
            "[data-workbench-window] [data-window-bar=browser]",
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

  // A frame that unloads drops its animation frames. A seek that waited on one never ended, and a
  // CLI shot failed with "evaluate: Resulting promise was garbage collected".
  test("a seek ends when the app frame drops its frames and loads again", async () => {
    if (!server) throw new Error("No server.");
    const page = await openPage();
    try {
      await page.goto(`${server.url}/workbench/?scene=app-home-bots`);
      await waitReady(page);
      const first = await page.evaluate(async () => {
        const iframe = document.querySelector("iframe");
        const win = iframe?.contentWindow;
        if (!win) throw new Error("No app frame.");
        // From now on the frame draws no frame, as a frame that unloads.
        win.requestAnimationFrame = () => 0;
        const seek = window.__workbenchPage?.seek(1000);
        const ended = await Promise.race([
          seek?.then(() => "ended"),
          new Promise((done) => setTimeout(() => done("hung"), 10_000)),
        ]);
        win.location.reload();
        return ended;
      });
      expect(first).toBe("ended");
      // The frame loaded again: a seek ends on the new load, ready, with the app drawn.
      await page.evaluate(() => window.__workbenchPage?.seek(1000));
      await waitReady(page);
      const after = await page.evaluate(() => ({
        at: window.__workbenchPage?.now(),
        text: document.querySelector("iframe")?.contentDocument?.body.innerText,
      }));
      expect(after.at).toBe(1000);
      expect(after.text).toContain("Start a conversation");
    } finally {
      await page.close();
    }
  }, 120_000);
});
