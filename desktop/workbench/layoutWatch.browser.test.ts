import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Warning } from "./layoutWatch";
import {
  ensureServer,
  HOOK_START_MS,
  HOOK_STOP_MS,
  sharedChromium,
} from "./server";
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
  hover(): Promise<void>;
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
  waitForSelector(
    selector: string,
    options?: { timeout?: number },
  ): Promise<unknown>;
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

  test("Spacing: Dusty's Connections layout is too near the Mac buttons", async () => {
    if (!browser) throw new Error("No browser.");
    const page = await browser.newPage({
      viewport: { width: 1200, height: 800 },
    });
    try {
      await openScene(page, "state-first-run");
      // Dusty's capture as DOM: a 73 px strip with the orb, and an inset panel 5 px past the
      // green light, 8 px down, with a border and a rounded corner. A string, so the import runs
      // in the page as written.
      const texts = await page.evaluate<string[]>(`(async () => {
        const body = document.createElement("body");
        body.style.cssText = "margin: 0; background: rgb(17, 17, 20); width: 1142px; height: 800px";
        body.innerHTML = [
          '<div data-slot="strip" style="position: absolute; left: 0; top: 0; width: 73px; height: 800px">',
          '<img alt="OpenBot" style="position: absolute; left: 22px; top: 54px; width: 28px; height: 28px; background: #888">',
          '</div>',
          '<main data-slot="sidebar-inset" style="position: absolute; left: 79px; top: 8px; width: 1055px; height: 784px; border: 1px solid rgb(60, 60, 66); border-radius: 12px; background: rgb(24, 24, 28)"></main>',
        ].join("");
        document.body.replaceWith(body);
        const { spacingWarnings } = await import("/workbench/layoutWatch.ts");
        const buttons = { x: 21, y: 27, width: 53, height: 12 };
        return spacingWarnings(document, 0, { width: 1142, height: 800 }, buttons)
          .map((warning) => warning.rule + ": " + warning.text);
      })()`);
      expect(texts).toContain(
        'clearance: panel <main data-slot="sidebar-inset"> is 5 px from the window buttons',
      );
      expect(
        texts.some((t) =>
          t.startsWith("column: The window buttons sit 8 px right"),
        ),
      ).toBe(true);
      expect(
        texts.some((t) =>
          t.startsWith('row: panel <main data-slot="sidebar-inset"> starts'),
        ),
      ).toBe(true);
      // No buttons (Windows, a browser): no Spacing check.
      const none = await page.evaluate<number>(`(async () => {
        const { spacingWarnings } = await import("/workbench/layoutWatch.ts");
        return spacingWarnings(document, 0, { width: 1142, height: 800 }, null).length;
      })()`);
      expect(none).toBe(0);
    } finally {
      await page.close();
    }
  }, 30_000);

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

  test("only text a box really hides counts as cut off", async () => {
    if (!browser) throw new Error("No browser.");
    const page = await browser.newPage({
      viewport: { width: 800, height: 600 },
    });
    try {
      await openScene(page, "state-first-run");
      // A string, so the import runs in the page as written.
      const labels = await page.evaluate<string[]>(`(async () => {
        const body = document.createElement("body");
        body.innerHTML = [
          // Cut off: a box with hidden overflow hides the end of the line.
          '<div style="width: 100px; white-space: nowrap; overflow: hidden">Cut off by the box around it</div>',
          // An ellipsis on purpose (Tailwind's truncate).
          '<span style="display: block; width: 100px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis">An ellipsis on purpose here</span>',
          // An ellipsis on the box that cuts the text.
          '<div style="width: 100px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis"><span>An ellipsis on the parent</span></div>',
          // Clamped to two lines.
          '<p style="width: 100px; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden">Clamped to two lines of text, the rest is gone on purpose</p>',
          // A 28 px line in a 25 px button with overflow visible: nothing is hidden.
          '<button role="tab" style="height: 25px; line-height: 28px; padding: 0; border: 0">Overflows but shows</button>',
        ].join("");
        document.body.replaceWith(body);
        const { clippedAndOutside } = await import("/workbench/layoutWatch.ts");
        return clippedAndOutside(document, 0, { width: innerWidth, height: innerHeight })
          .filter((warning) => warning.kind === "clipped")
          .map((warning) => warning.label);
      })()`);
      expect(labels).toEqual(['div "Cut off by the box around it"']);
    } finally {
      await page.close();
    }
  }, 30_000);

  test("an element below the window is not outside when the page scrolls to it", async () => {
    if (!browser) throw new Error("No browser.");
    const page = await browser.newPage({
      viewport: { width: 800, height: 600 },
    });
    try {
      await openScene(page, "state-first-run");
      const labels = await page.evaluate<string[]>(`(async () => {
        const body = document.createElement("body");
        body.innerHTML = [
          '<p style="margin-top: 900px">Below the fold</p>',
          '<p style="position: fixed; top: 620px">Fixed below the window</p>',
        ].join("");
        document.documentElement.style.overflow = "visible";
        document.body.replaceWith(body);
        body.style.overflow = "visible";
        body.style.height = "auto";
        const { clippedAndOutside } = await import("/workbench/layoutWatch.ts");
        return clippedAndOutside(document, 0, { width: innerWidth, height: innerHeight })
          .filter((warning) => warning.kind === "outside")
          .map((warning) => warning.label);
      })()`);
      expect(labels).toEqual(['p "Fixed below the window"']);
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

  test("a hover on a warning jumps to its time and shows the move over the window", async () => {
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
      await page.evaluate((ms) => window.__workbenchPage?.seek(ms), end);
      // Any move does. The background row's name used to move here; it holds still now that the
      // sidebar's foot holds its height, so the move is whichever the run still has.
      const warning = (await warningsOf(page)).find((w) => w.kind === "moved");
      if (warning?.kind !== "moved") throw new Error("No move in install-mac.");
      // The warning has where the row was and where it went.
      expect(warning.to.y - warning.from.y).toBe(warning.dy);

      // A move after an input is expected, so behind the toggle: show them all.
      await page
        .mainFrame()
        .getByRole("checkbox", { name: "Show expected moves" })
        .click();
      // The move is earlier than the end: the hover seeks back.
      await page
        .mainFrame()
        .getByRole("button", { name: warningText(warning) })
        .hover();
      // A move late in the run is replayed from the start: about 45 s to 3:52 on a busy machine.
      await page.waitForSelector(
        "[data-workbench-highlight='moved'] [data-highlight-label]",
        { timeout: 150_000 },
      );
      expect(await page.evaluate(() => window.__workbenchPage?.now())).toBe(
        warning.at,
      );
      const shown = await page.evaluate(() => {
        const root = document.querySelector("[data-workbench-highlight]");
        return {
          label: root?.querySelector("[data-highlight-label]")?.textContent,
          boxes: [
            ...(root?.querySelectorAll("[data-highlight-box]") ?? []),
          ].map((el) => el.getAttribute("data-highlight-box")),
          inWindow: root
            ? root.closest("[data-workbench-window]") !== null
            : null,
        };
      });
      expect(shown.label).toMatch(/^moved \d+ px (down|up)/);
      expect(shown.boxes).toEqual(["from", "to"]);
      // Not in the window element, so a shot of the window does not show it.
      expect(shown.inWindow).toBe(false);
    } finally {
      await page.close();
    }
  }, 300_000);
});
