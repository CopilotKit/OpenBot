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
  locator(selector: string): Locator & {
    first(): Locator;
    nth(index: number): Locator;
  };
  mouse: { move(x: number, y: number): Promise<void> };
  screenshot(options: {
    clip: { x: number; y: number; width: number; height: number };
  }): Promise<Uint8Array>;
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

/** The share of pixels that differ between two PNG shots of the same size, decoded in the page. */
function changedShare(page: Page, a: Uint8Array, b: Uint8Array) {
  return page.evaluate(
    async ([one, two]) => {
      const pixels = async (base64: string) => {
        const blob = await (
          await fetch(`data:image/png;base64,${base64}`)
        ).blob();
        const bitmap = await createImageBitmap(blob);
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        const context = canvas.getContext("2d");
        if (!context) throw new Error("No 2d context.");
        context.drawImage(bitmap, 0, 0);
        return context.getImageData(0, 0, bitmap.width, bitmap.height);
      };
      const [x, y] = await Promise.all([pixels(one), pixels(two)]);
      if (x.width !== y.width || x.height !== y.height) return 1;
      let changed = 0;
      for (let i = 0; i < x.data.length; i += 4) {
        // A pixel counts as changed past a small difference (anti-aliasing, the caret).
        if (
          Math.abs((x.data[i] ?? 0) - (y.data[i] ?? 0)) > 24 ||
          Math.abs((x.data[i + 1] ?? 0) - (y.data[i + 1] ?? 0)) > 24 ||
          Math.abs((x.data[i + 2] ?? 0) - (y.data[i + 2] ?? 0)) > 24
        )
          changed++;
      }
      return changed / (x.width * x.height);
    },
    [Buffer.from(a).toString("base64"), Buffer.from(b).toString("base64")] as [
      string,
      string,
    ],
  );
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
    test(`the Install marker, or its ghost when the screen changed at once, shows for at least 400 ms (${reducedMotion})`, async () => {
      if (!browser) throw new Error("No browser.");
      const page = await browser.newPage({
        viewport: { width: 1600, height: 1000 },
        reducedMotion,
      });
      try {
        await openScene(page, "install-mac");
        await page.getByLabel("Pause at each action").check();
        await page.getByRole("button", { name: "Play" }).click();
        await page.waitForFunction(() =>
          /Install/.test(
            document.querySelector(".wb-action-next .wb-action-label")
              ?.textContent ?? "",
          ),
        );
        // Each animation frame from the click on: is the Install marker (or its ghost) drawn.
        await page.evaluate(() => {
          const seen: {
            t: number;
            shown: boolean;
            ghost: boolean;
            opacity: number;
          }[] = [];
          (window as unknown as { __seen: typeof seen }).__seen = seen;
          const tick = () => {
            const mark = [
              ...document.querySelectorAll(".wb-action:not(.wb-action-next)"),
            ].find((m) => /Install/.test(m.textContent ?? ""));
            const opacity = mark
              ? Number.parseFloat(getComputedStyle(mark).opacity)
              : 0;
            seen.push({
              t: performance.now(),
              shown: opacity > 0,
              ghost: !!mark?.classList.contains("wb-action-ghost"),
              opacity,
            });
            if (seen.length < 600) requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        });
        await page.getByRole("button", { name: "Play" }).click();
        await page.waitForTimeout(1600);
        const seen = await page.evaluate(
          () =>
            (
              window as unknown as {
                __seen: {
                  t: number;
                  shown: boolean;
                  ghost: boolean;
                  opacity: number;
                }[];
              }
            ).__seen,
        );
        const shown = seen.filter((s) => s.shown);
        expect(shown.length).toBeGreaterThan(0);
        const from = shown[0]?.t ?? 0;
        const to = shown[shown.length - 1]?.t ?? 0;
        expect(to - from).toBeGreaterThanOrEqual(400);
        // Shown without a gap, and gone by MARKER_MS.
        const first = seen.findIndex((s) => s.shown);
        const last =
          seen.length - 1 - [...seen].reverse().findIndex((s) => s.shown);
        expect(seen.slice(first, last + 1).every((s) => s.shown)).toBe(true);
        expect(to - from).toBeLessThanOrEqual(1300);
        // The ghost's label can be read: it holds full opacity for most of GHOST_MS and fades only
        // at the end. The Install click changes the screen at once, so the marker is a ghost.
        const ghostFrom = seen.find((s) => s.ghost)?.t;
        expect(ghostFrom).toBeDefined();
        const late = seen.filter(
          (s) =>
            s.ghost &&
            s.t - (ghostFrom ?? 0) >= 250 &&
            s.t - (ghostFrom ?? 0) <= 320,
        );
        expect(late.length).toBeGreaterThan(0);
        for (const s of late) expect(s.opacity).toBeGreaterThanOrEqual(0.9);
      } finally {
        await page.close();
      }
    }, 60_000);

    test(`a warning hover that seeks back shows the window as it was last painted until the target state (${reducedMotion})`, async () => {
      if (!browser) throw new Error("No browser.");
      const page = await browser.newPage({
        viewport: { width: 1600, height: 1000 },
        reducedMotion,
      });
      try {
        await openScene(page, "install-mac");
        // At the run's end: a dark window under the "OpenBot opens here" card, with its title bar.
        await page.evaluate(() => window.__workbenchPage?.seek(240_000));
        await page.waitForSelector(".wb-warning-list button");
        await page.waitForTimeout(300);
        // The part of the window on screen: the stage clips it, and the warnings panel under the
        // stage (where the hovered row changes) is not the window.
        const clip = await page.evaluate(() => {
          const element = document.querySelector("[data-workbench-window]");
          if (!element) return null;
          let r = element.getBoundingClientRect();
          for (let up = element.parentElement; up; up = up.parentElement) {
            if (getComputedStyle(up).overflow === "visible") continue;
            const s = up.getBoundingClientRect();
            const x = Math.max(r.left, s.left);
            const y = Math.max(r.top, s.top);
            r = new DOMRect(
              x,
              y,
              Math.min(r.right, s.right) - x,
              Math.min(r.bottom, s.bottom) - y,
            );
          }
          return {
            x: Math.ceil(r.x),
            y: Math.ceil(r.y),
            width: Math.floor(r.width),
            height: Math.floor(r.height),
          };
        });
        if (!clip) throw new Error("No window.");
        const before = await page.screenshot({ clip });
        const state = () =>
          page.evaluate(() => ({
            ready: window.__workbenchPage?.ready === true,
            highlight:
              document.querySelector("[data-workbench-highlight]") !== null,
          }));
        await page.locator(".wb-warning-list button").first().hover();
        const shares: number[] = [];
        const deadline = Date.now() + 15_000;
        while (Date.now() < deadline) {
          const start = await state();
          if (start.highlight) break;
          const shot = await page.screenshot({ clip });
          const end = await state();
          // Only a shot taken wholly while the window was not ready: the target frame is not there yet.
          if (!start.ready && !end.ready)
            shares.push(await changedShare(page, before, shot));
        }
        expect(shares.length).toBeGreaterThan(0);
        for (const share of shares) expect(share).toBeLessThan(0.02);
      } finally {
        await page.close();
      }
    }, 120_000);

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
        // The list did not shrink under the pointer. It can grow: the replay can find a warning the
        // first walk did not, since the layout watch checks on animation frames, and a loaded
        // machine draws other frames.
        expect(
          await page.evaluate(
            () => document.querySelectorAll(".wb-warning-list li").length,
          ),
        ).toBeGreaterThanOrEqual(rowCount);
      } finally {
        await page.close();
      }
    }, 120_000);

    test(`while the pointer is in the list, a warning hover that seeks back keeps the hovered row in its place and every row (${reducedMotion})`, async () => {
      if (!browser) throw new Error("No browser.");
      const page = await browser.newPage({
        viewport: { width: 1600, height: 1000 },
        reducedMotion,
      });
      try {
        // As the review found it: a row early in the run that the replay does not find again (there
        // a 0:00 page move from the load), above the hovered 0:37 row. Here the test makes one: at
        // 0:10 it moves the window's content by hand, which the replay does not do.
        await openScene(page, "install-mac");
        await page.evaluate(() => window.__workbenchPage?.seek(10_000));
        await page.waitForTimeout(300);
        await page.evaluate(() => {
          const doc = document.querySelector<HTMLIFrameElement>(
            "[data-workbench-window] iframe",
          )?.contentDocument;
          const push = doc?.createElement("div");
          if (!doc || !push) throw new Error("No window.");
          push.style.height = "40px";
          doc.body.prepend(push);
        });
        // The watch checks after the clock moves.
        await page.evaluate(() => window.__workbenchPage?.seek(11_000));
        await page.waitForFunction(() =>
          (window.__workbenchPage?.warnings() ?? []).some(
            (w) => w.at < 37_000 && w.at >= 10_000,
          ),
        );
        await page.evaluate(() => window.__workbenchPage?.seek(240_000));
        await page.waitForSelector(".wb-warning-list button");
        await page.waitForTimeout(300);
        const rowCount = await page.evaluate(
          () => document.querySelectorAll(".wb-warning-list li").length,
        );
        expect(rowCount).toBeGreaterThan(1);
        const rows = await page.evaluate(() =>
          [...document.querySelectorAll(".wb-warning-list button")].map(
            (b) => b.textContent ?? "",
          ),
        );
        const index = rows.findIndex((t) => / at 0:37 /.test(t));
        expect(index).toBeGreaterThan(0);
        const text = rows[index] ?? "";
        // Each animation frame: how many rows, and where the hovered row is.
        await page.evaluate((hovered) => {
          const samples: {
            rows: number;
            y: number | null;
            seeking: boolean;
          }[] = [];
          (window as unknown as { __rows: typeof samples }).__rows = samples;
          const tick = () => {
            const row = [
              ...document.querySelectorAll(".wb-warning-list button"),
            ].find((b) => (b.textContent ?? "").startsWith(hovered));
            samples.push({
              rows: document.querySelectorAll(".wb-warning-list li").length,
              y: row ? row.getBoundingClientRect().top : null,
              seeking: /Seeking to/.test(
                document.querySelector(".wb-warnings h3")?.textContent ?? "",
              ),
            });
            requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        }, text);
        await page.locator(".wb-warning-list button").nth(index).hover();
        await page.waitForSelector("[data-workbench-highlight]");
        // The replay goes on after the warning shows; the pointer stays in the list.
        await page.waitForTimeout(1500);
        const samples = await page.evaluate(
          () =>
            (
              window as unknown as {
                __rows: { rows: number; y: number | null; seeking: boolean }[];
              }
            ).__rows,
        );
        expect(samples.some((s) => s.seeking)).toBe(true);
        const y = samples[0]?.y;
        expect(y).not.toBeNull();
        for (const s of samples) {
          expect(s.rows).toBeGreaterThanOrEqual(rowCount);
          expect(s.y).toBe(y ?? null);
        }
      } finally {
        await page.close();
      }
    }, 120_000);
  }
});
