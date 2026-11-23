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
/**
 * Turns on "Show expected moves" under the window, so the list has every row: install-mac's moves
 * are all expected (after an input, while a screen loads), and these tests are about the rows.
 */
async function showExpectedMoves(page: Page): Promise<void> {
  const box = page.getByRole("checkbox", { name: /^Show expected moves/ });
  await box.waitFor();
  await box.check();
}

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

/**
 * The share of pixels that differ between two PNG shots of the same size, decoded in the page, and
 * the box the changed pixels lie in (null when none did). With `near` 1, a pixel that matches one
 * within a pixel of it in the other shot has not changed: text drawn a pixel over, or with other
 * anti-aliasing, is the same text.
 */
async function changed(
  page: Page,
  a: Uint8Array,
  b: Uint8Array,
  near = 0,
): Promise<{
  share: number;
  box: { x: number; y: number; width: number; height: number } | null;
}> {
  return page.evaluate(
    async ([one, two, radius]) => {
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
      if (x.width !== y.width || x.height !== y.height)
        return { share: 1, box: null };
      const { width, height } = x;
      // A pixel counts as the same past a small difference (anti-aliasing, the caret).
      const same = (from: ImageData, i: number, to: ImageData, j: number) =>
        Math.abs((from.data[i] ?? 0) - (to.data[j] ?? 0)) <= 24 &&
        Math.abs((from.data[i + 1] ?? 0) - (to.data[j + 1] ?? 0)) <= 24 &&
        Math.abs((from.data[i + 2] ?? 0) - (to.data[j + 2] ?? 0)) <= 24;
      const matched = (
        from: ImageData,
        to: ImageData,
        px: number,
        py: number,
      ) => {
        const i = (py * width + px) * 4;
        for (let dy = -radius; dy <= radius; dy++) {
          for (let dx = -radius; dx <= radius; dx++) {
            const qx = px + dx;
            const qy = py + dy;
            if (qx < 0 || qy < 0 || qx >= width || qy >= height) continue;
            if (same(from, i, to, (qy * width + qx) * 4)) return true;
          }
        }
        return false;
      };
      let changed = 0;
      let left = Infinity;
      let top = Infinity;
      let right = -1;
      let bottom = -1;
      for (let at = 0; at < width * height; at++) {
        const px = at % width;
        const py = Math.floor(at / width);
        if (!matched(x, y, px, py) || !matched(y, x, px, py)) {
          changed++;
          left = Math.min(left, px);
          top = Math.min(top, py);
          right = Math.max(right, px);
          bottom = Math.max(bottom, py);
        }
      }
      return {
        share: changed / (width * height),
        box:
          right < 0
            ? null
            : {
                x: left,
                y: top,
                width: right - left + 1,
                height: bottom - top + 1,
              },
      };
    },
    [
      Buffer.from(a).toString("base64"),
      Buffer.from(b).toString("base64"),
      near,
    ] as [string, string, number],
  );
}

/** The share alone. */
async function changedShare(page: Page, a: Uint8Array, b: Uint8Array) {
  return (await changed(page, a, b)).share;
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

  // A seek back starts a new window, whose warnings start empty. The rows stay: the ones the replay
  // has not reached show muted. A merge at the old window's time once emptied the list. The test
  // once wanted every row back, and failed on CI when a 0:00 row was not found again.
  test("a seek back keeps the rows; the ones after the new time show muted", async () => {
    if (!browser) throw new Error("No browser.");
    const page = await browser.newPage({
      viewport: { width: 1600, height: 1000 },
    });
    try {
      await openScene(page, "install-mac");
      const rows = () =>
        page.evaluate(() => ({
          all: document.querySelectorAll('ul[aria-label="Layout warnings"] li')
            .length,
          muted: document.querySelectorAll(
            'ul[aria-label="Layout warnings"] [data-later]',
          ).length,
        }));
      const warnings = () =>
        page.evaluate(() =>
          (window.__workbenchPage?.warnings() ?? []).map(
            (w) => `${w.kind}|${w.at}|${w.label}`,
          ),
        );
      const at = (key: string) => Number(key.split("|")[1]);
      await page.evaluate(() => window.__workbenchPage?.seek(240_000));
      await showExpectedMoves(page);
      await page.waitForTimeout(300);
      const atEnd = await rows();
      const endFound = await warnings();
      expect(atEnd.all).toBeGreaterThan(0);
      expect(atEnd.all).toBe(endFound.length);
      expect(atEnd.muted).toBe(0);
      await page.evaluate(() => window.__workbenchPage?.seek(10_000));
      await page.waitForTimeout(300);
      const after = await rows();
      // What the replay found up to 0:10 shows as found; every row after 0:10 stays, muted. A row
      // before 0:10 the replay did not find again is gone from the run and may go (the 0:00 moves
      // come from the window's first layout, which a replay does not always repeat).
      const found = await warnings();
      const ahead = endFound.filter(
        (key) => at(key) >= 10_000 && !found.includes(key),
      );
      expect(ahead.length).toBeGreaterThan(0);
      expect(after.muted).toBe(after.all - found.length);
      expect(after.muted).toBeGreaterThanOrEqual(ahead.length);
      expect(after.all).toBeGreaterThanOrEqual(found.length + ahead.length);
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
        await showExpectedMoves(page);
        await showExpectedMoves(page);
        await page.waitForSelector('ul[aria-label="Layout warnings"] button');
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
        // The window as it was last painted is the window once it settled. A fixed 300 ms wait can
        // take it mid-transition on a slower runner, while the still shows every animation at its
        // end: only the no-preference run failed on CI, with a frame 2.2% off (0.01% here).
        // Settled: two shots 100 ms apart differ only by what never stops (the spinners turn),
        // under half of the share the check below allows.
        let before = await page.screenshot({ clip });
        for (let tries = 0; ; tries++) {
          await page.waitForTimeout(100);
          const next = await page.screenshot({ clip });
          const drift = await changedShare(page, before, next);
          before = next;
          if (drift < 0.01) break;
          if (tries >= 50)
            throw new Error(`The window never settled: ${drift}`);
        }
        const state = () =>
          page.evaluate(() => ({
            ready: window.__workbenchPage?.ready === true,
            highlight:
              document.querySelector("[data-workbench-highlight]") !== null,
          }));
        await page
          .locator('ul[aria-label="Layout warnings"] button')
          .first()
          .hover();
        const shares: number[] = [];
        let dumped = 0;
        const deadline = Date.now() + 15_000;
        while (Date.now() < deadline) {
          const start = await state();
          if (start.highlight) break;
          const shot = await page.screenshot({ clip });
          const end = await state();
          // Only a shot taken wholly while the window was not ready: the target frame is not there yet.
          if (!start.ready && !end.ready) {
            // Within a pixel, so text drawn a pixel over or with other anti-aliasing is the same.
            const change = await changed(page, before, shot, 1);
            shares.push(change.share);
            // Where a frame changed, and what covered the window then, so a failure says why.
            if (change.share >= 0.005)
              console.log(
                "A frame changed:",
                JSON.stringify({
                  ...change,
                  exact: await changedShare(page, before, shot),
                  ...(await page.evaluate(() => {
                    const still = document.querySelector<HTMLIFrameElement>(
                      "[data-workbench-still]",
                    );
                    return {
                      still: still ? still.style.visibility || "shown" : "none",
                    };
                  })),
                }),
              );
            // On CI the still's card differs from the window's by about 2% (0.01% here), and only
            // where motion is allowed. Both shots, cut to where they differ, so the log shows what.
            if (change.share >= 0.02 && change.box && dumped < 2) {
              dumped++;
              const box = change.box;
              const crops = await page.evaluate(
                async ([one, two, at]) => {
                  const crop = async (base64: string) => {
                    const blob = await (
                      await fetch(`data:image/png;base64,${base64}`)
                    ).blob();
                    const bitmap = await createImageBitmap(blob);
                    const canvas = document.createElement("canvas");
                    canvas.width = at.width;
                    canvas.height = at.height;
                    canvas.getContext("2d")?.drawImage(bitmap, -at.x, -at.y);
                    return canvas.toDataURL("image/png");
                  };
                  return [await crop(one), await crop(two)];
                },
                [
                  Buffer.from(before).toString("base64"),
                  Buffer.from(shot).toString("base64"),
                  box,
                ] as [string, string, typeof box],
              );
              console.log(`Before, cut: ${crops[0]}`);
              console.log(`The frame, cut: ${crops[1]}`);
            }
          }
        }
        console.log(
          `Most of the window a frame changed: ${Math.max(...shares)}`,
        );
        expect(shares.length).toBeGreaterThan(0);
        // An uncovered replay changes most of the window: 89% when this was found, 99.7% for the
        // window starting again, and 6.4% for a dark window whose card has not drawn yet. CI's
        // still differs from its window by 2.1% even so (see the shots logged above), here by
        // 0.05%. The bound sits between the two.
        for (const share of shares) expect(share).toBeLessThan(0.05);
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
        await showExpectedMoves(page);
        await showExpectedMoves(page);
        await page.waitForSelector('ul[aria-label="Layout warnings"] button');
        const rows = await page.evaluate(
          () =>
            [
              ...document.querySelectorAll(
                'ul[aria-label="Layout warnings"] button',
              ),
            ].map((b) => b.textContent ?? "").length,
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
                [...document.querySelectorAll("h3")].find((h) =>
                  (h.textContent ?? "").startsWith("Layout warnings"),
                )?.textContent ?? "",
              ),
              highlight:
                document.querySelector("[data-workbench-highlight]") !== null,
            });
            requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        });
        const rowCount = await page.evaluate(
          () =>
            document.querySelectorAll('ul[aria-label="Layout warnings"] li')
              .length,
        );
        // The first row is the earliest warning: a seek back from the end.
        await page
          .locator('ul[aria-label="Layout warnings"] button')
          .first()
          .hover();
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
            () =>
              document.querySelectorAll('ul[aria-label="Layout warnings"] li')
                .length,
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
        await showExpectedMoves(page);
        await showExpectedMoves(page);
        await page.waitForSelector('ul[aria-label="Layout warnings"] button');
        await page.waitForTimeout(300);
        const rowCount = await page.evaluate(
          () =>
            document.querySelectorAll('ul[aria-label="Layout warnings"] li')
              .length,
        );
        expect(rowCount).toBeGreaterThan(1);
        const rows = await page.evaluate(() =>
          [
            ...document.querySelectorAll(
              'ul[aria-label="Layout warnings"] button',
            ),
          ].map((b) => b.textContent ?? ""),
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
              ...document.querySelectorAll(
                'ul[aria-label="Layout warnings"] button',
              ),
            ].find((b) => (b.textContent ?? "").startsWith(hovered));
            samples.push({
              rows: document.querySelectorAll(
                'ul[aria-label="Layout warnings"] li',
              ).length,
              y: row ? row.getBoundingClientRect().top : null,
              seeking: /Seeking to/.test(
                [...document.querySelectorAll("h3")].find((h) =>
                  (h.textContent ?? "").startsWith("Layout warnings"),
                )?.textContent ?? "",
              ),
            });
            requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        }, text);
        await page
          .locator('ul[aria-label="Layout warnings"] button')
          .nth(index)
          .hover();
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
