import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { Browser, BrowserType, Page } from "playwright-core";
import { renderToStaticMarkup } from "react-dom/server";
import { ProgressRow } from "../src/components/channels/progress-row";
import { ToolLine } from "../src/components/channels/tool-line";

/**
 * A running step's words shimmer: a soft band of light sweeps across them, left to right at an even
 * pace, and they stay still and readable under reduced motion. A finished step does not shimmer.
 *
 * The band is a mask over the words, not a gradient painted through them, so the words keep their
 * own colours and their own fill. An earlier sweep crossed the words in under half a second every
 * 1.6 seconds and then held still, and on the Mac it read as the text blinking; this one is pinned by
 * sampling the running animation itself: a cycle of two to three seconds, at an even pace the whole
 * way, the band travelling from beyond the left edge to beyond the right, and the words never held
 * below half strength.
 *
 * Reduced motion has broken these words before. That earlier sweep painted a gradient through the
 * glyphs and made their own fill transparent, and the reduced-motion branch dropped the gradient but
 * left the fill transparent, so on a computer with animations turned off (Windows with "Animation
 * effects" off, macOS with "Reduce motion") every running step showed only its caret: "Asked you ·
 * Which city should I search" was blank. The checks below still hold the words to being drawn.
 *
 * Rendered in a real browser, because the cascade of a media query, a layered utility and an
 * unlayered rule is what broke, and only a browser resolves it the way the app's WebView does. The
 * markup is the real components'; the stylesheet is the app's own. The two Tailwind utilities the
 * line wears are declared the way Tailwind v4 emits them, in `@layer utilities`, which an unlayered
 * rule outranks.
 *
 *   OPENBOT_APP_BROWSER=1 bun test app/tests/tool-line-reduced-motion.test.tsx
 *
 * Chromium by default, as CI has it. OPENBOT_APP_ENGINES=chromium,webkit adds WebKit, the engine of
 * the Mac app's window.
 */
const asked = process.env.OPENBOT_APP_BROWSER === "1";
const engines = (process.env.OPENBOT_APP_ENGINES ?? "chromium")
  .split(",")
  .map((engine) => engine.trim())
  .filter((engine) => engine === "chromium" || engine === "webkit") as (
  | "chromium"
  | "webkit"
)[];

const read = (path: string) =>
  readFileSync(new URL(path, import.meta.url), "utf8");

const PAGE = `<!doctype html>
<style>@layer theme, base, components, utilities;</style>
<style>${read("../src/theme.css")}</style>
<style>${read("../src/styles.css")}</style>
<style>
  @layer utilities {
    .text-muted-foreground { color: var(--muted-foreground); }
    .text-sm { font-size: 0.875rem; line-height: 1.25rem; }
  }
  body { background: var(--background); color: var(--foreground); font: 16px sans-serif; }
</style>
<main>
  <div id="tool-line">${renderToStaticMarkup(
    <ToolLine label="Asked you" detail="Which city should I search?" running>
      <p>Waiting for an answer.</p>
    </ToolLine>,
  )}</div>
  <div id="progress-row">${renderToStaticMarkup(
    <ProgressRow label="Asking Ana…" />,
  )}</div>
  <div id="finished">${renderToStaticMarkup(
    <ToolLine label="Searched the web" detail="top articles today">
      <p>Five results.</p>
    </ToolLine>,
  )}</div>
  <span id="muted" class="text-muted-foreground">muted</span>
</main>`;

const TRANSPARENT = "rgba(0, 0, 0, 0)";

const browsers = new Map<string, Browser>();

beforeAll(async () => {
  if (!asked) return;
  const playwright = await import("playwright-core");
  for (const engine of engines) {
    const type: BrowserType = playwright[engine];
    browsers.set(
      engine,
      // The CI job installs full Chromium without the headless shell.
      await type.launch(engine === "chromium" ? { channel: "chromium" } : {}),
    );
  }
}, 120_000);

afterAll(async () => {
  for (const browser of browsers.values()) await browser.close();
});

async function open(
  engine: string,
  reducedMotion: "reduce" | "no-preference",
): Promise<Page> {
  const browser = browsers.get(engine);
  if (!browser) throw new Error(`no ${engine}`);
  const page = await browser.newPage();
  await page.emulateMedia({ reducedMotion });
  await page.setContent(PAGE);
  return page;
}

/** How each running label is painted: its colour, its glyph fill, what is behind it and over it. */
function painted(page: Page) {
  return page.$$eval(".tool-line-running", (lines) =>
    lines.map((line) => {
      const style = getComputedStyle(line);
      return {
        text: line.textContent,
        color: style.color,
        fill: style.webkitTextFillColor,
        background: style.backgroundImage,
        mask: style.maskImage || style.webkitMaskImage,
        animation: style.animationName,
      };
    }),
  );
}

for (const engine of engines)
  describe.skipIf(!asked)(`a running step, in ${engine}`, () => {
    test("under reduced motion every running label is drawn in its own tone, standing still", async () => {
      const page = await open(engine, "reduce");
      try {
        expect(
          await page.evaluate(
            () => matchMedia("(prefers-reduced-motion: reduce)").matches,
          ),
        ).toBe(true);
        const muted = await page.$eval(
          "#muted",
          (probe) => getComputedStyle(probe).color,
        );
        const lines = await painted(page);
        expect(lines.map((line) => line.text)).toEqual([
          "Asked youWhich city should I search?",
          "Asking Ana…",
        ]);
        for (const line of lines) {
          expect(line.fill).not.toBe(TRANSPARENT);
          expect(line.fill).toBe(line.color);
          // The line's own muted tone, not the darker colour of what holds it.
          expect(line.color).toBe(muted);
          expect(line.background).toBe("none");
          expect(line.mask).toBe("none");
          expect(line.animation).toBe("none");
        }
      } finally {
        await page.close();
      }
    });

    test("under reduced motion the words are on screen, not only in the computed style", async () => {
      const page = await open(engine, "reduce");
      try {
        // The whole row, caret and all, as the person sees it.
        const row = page.locator("#tool-line summary");
        const shown = await row.screenshot();
        await row.locator(".tool-line-running").evaluate((line) => {
          (line as HTMLElement).style.visibility = "hidden";
        });
        const caretOnly = await row.screenshot();
        // Identical pixels with the words hidden would mean only the caret was ever drawn.
        expect(shown.equals(caretOnly)).toBe(false);
      } finally {
        await page.close();
      }
    });

    test("with motion allowed a band of light sweeps across the words at an even pace, and a finished step stands still", async () => {
      const page = await open(engine, "no-preference");
      try {
        for (const line of await painted(page)) {
          expect(line.animation).toBe("tool-line-shimmer");
          // The words are drawn in their own colour the whole time, never through a transparent fill.
          expect(line.fill).not.toBe(TRANSPARENT);
          expect(line.fill).toBe(line.color);
          expect(line.background).toBe("none");
          expect(line.mask).toContain("linear-gradient");
          // Held a little over half strength outside the band, and drawn in full inside it.
          expect(line.mask).toMatch(/0\.55\)/);
        }
        // A step that has finished has no band and no motion.
        const finished = await page.$eval(
          "#finished summary > span + span",
          (line) => {
            const style = getComputedStyle(line);
            return {
              mask: style.maskImage || style.webkitMaskImage,
              animation: style.animationName,
            };
          },
        );
        expect(finished).toEqual({ mask: "none", animation: "none" });

        const cycles = await page.$$eval(".tool-line-running", (lines) =>
          lines.map((line) => {
            const [sweep] = line.getAnimations();
            sweep.pause();
            const timing = sweep.effect?.getComputedTiming();
            const duration = Number(timing?.duration);
            // Ten points across one cycle, read back as the browser places the mask. The eleventh
            // would be the next cycle's first.
            const positions: number[] = [];
            for (let i = 0; i < 10; i++) {
              sweep.currentTime = (duration * i) / 10;
              const style = getComputedStyle(line);
              const at = (style.maskPosition || style.webkitMaskPosition)
                .split(" ")[0]
                .trim();
              positions.push(Number.parseFloat(at));
            }
            return {
              duration,
              iterations: timing?.iterations,
              easing: getComputedStyle(line).animationTimingFunction,
              positions,
            };
          }),
        );
        expect(cycles).toHaveLength(2);
        for (const cycle of cycles) {
          // Slow: one sweep every two to three seconds, well under three flashes a second.
          expect(cycle.duration).toBeGreaterThanOrEqual(2000);
          expect(cycle.duration).toBeLessThanOrEqual(3000);
          expect(cycle.iterations).toBe(Number.POSITIVE_INFINITY);
          // Even: the band never pauses and never darts, which is what read as a blink.
          expect(cycle.easing).toBe("linear");
          // From beyond the left edge (the mask's far end) to beyond the right, in equal steps.
          expect(cycle.positions[0]).toBe(100);
          expect(cycle.positions.at(-1)).toBeCloseTo(10, 0);
          for (let i = 1; i < cycle.positions.length; i++)
            expect(
              Math.abs(cycle.positions[i - 1] - cycle.positions[i] - 10),
            ).toBeLessThan(0.5);
        }
      } finally {
        await page.close();
      }
    });
  });
