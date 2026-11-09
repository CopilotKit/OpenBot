import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { Browser, Page } from "playwright-core";
import { renderToStaticMarkup } from "react-dom/server";
import { ProgressRow } from "../src/components/channels/progress-row";
import { ToolLine } from "../src/components/channels/tool-line";

/**
 * A running step's words pulse slowly, and stay still and readable under reduced motion.
 *
 * The words breathe rather than flash. A light band used to sweep through them every 1.6 seconds,
 * and on the Mac it read as the text blinking on and off quickly while the Bot worked. The pulse is
 * pinned by sampling the running animation itself: a cycle of two to three seconds, eased, and never
 * fading the words below half strength.
 *
 * Reduced motion has broken these words before. The sweep painted a gradient through the glyphs and
 * made their own fill transparent, and the reduced-motion branch dropped the gradient but left the
 * fill transparent, so on a computer with animations turned off (Windows with "Animation effects"
 * off, macOS with "Reduce motion") every running step showed only its caret: "Asked you · Which city
 * should I search" was blank. The checks below still hold the words to being drawn.
 *
 * Rendered in a real Chromium, because the cascade of a media query, a layered utility and an
 * unlayered rule is what broke, and only a browser resolves it the way the app's WebView does. The
 * markup is the real components'; the stylesheet is the app's own. The two Tailwind utilities the
 * line wears are declared the way Tailwind v4 emits them, in `@layer utilities`, which an unlayered
 * rule outranks.
 *
 *   OPENBOT_APP_BROWSER=1 bun test app/tests/tool-line-reduced-motion.test.tsx
 */
const asked = process.env.OPENBOT_APP_BROWSER === "1";

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
  <span id="muted" class="text-muted-foreground">muted</span>
</main>`;

const TRANSPARENT = "rgba(0, 0, 0, 0)";

let browser: Browser;

beforeAll(async () => {
  if (!asked) return;
  const { chromium } = await import("playwright-core");
  // The CI job installs full Chromium without the headless shell.
  browser = await chromium.launch({ channel: "chromium" });
});

afterAll(async () => {
  await browser?.close();
});

async function open(reducedMotion: "reduce" | "no-preference"): Promise<Page> {
  const page = await browser.newPage();
  await page.emulateMedia({ reducedMotion });
  await page.setContent(PAGE);
  return page;
}

/** How each running label is painted: its colour, its glyph fill and what is drawn behind it. */
function painted(page: Page) {
  return page.$$eval(".tool-line-running", (lines) =>
    lines.map((line) => {
      const style = getComputedStyle(line);
      return {
        text: line.textContent,
        color: style.color,
        fill: style.webkitTextFillColor,
        background: style.backgroundImage,
        animation: style.animationName,
      };
    }),
  );
}

describe.skipIf(!asked)("a running step under reduced motion", () => {
  test("every running label is drawn in its own tone, standing still", async () => {
    const page = await open("reduce");
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
        expect(line.animation).toBe("none");
      }
    } finally {
      await page.close();
    }
  });

  test("the words are on screen, not only in the computed style", async () => {
    const page = await open("reduce");
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

  test("with motion allowed the label pulses slowly, drawn in its own tone", async () => {
    const page = await open("no-preference");
    try {
      for (const line of await painted(page)) {
        expect(line.animation).toBe("tool-line-pulse");
        // The words are drawn the whole time, never through a transparent fill.
        expect(line.fill).not.toBe(TRANSPARENT);
        expect(line.fill).toBe(line.color);
        expect(line.background).toBe("none");
      }
      const cycles = await page.$$eval(".tool-line-running", (lines) =>
        lines.map((line) => {
          const [pulse] = line.getAnimations();
          pulse.pause();
          const timing = pulse.effect?.getComputedTiming();
          const duration = Number(timing?.duration);
          // Forty points across one cycle, read back as the browser draws them.
          const opacities: number[] = [];
          for (let i = 0; i <= 40; i++) {
            pulse.currentTime = (duration * i) / 40;
            opacities.push(Number(getComputedStyle(line).opacity));
          }
          return {
            duration,
            iterations: timing?.iterations,
            easing: getComputedStyle(line).animationTimingFunction,
            opacities,
          };
        }),
      );
      expect(cycles).toHaveLength(2);
      for (const cycle of cycles) {
        // Slow: one breath every two to three seconds, well under three flashes a second.
        expect(cycle.duration).toBeGreaterThanOrEqual(2000);
        expect(cycle.duration).toBeLessThanOrEqual(3000);
        expect(cycle.iterations).toBe(Number.POSITIVE_INFINITY);
        expect(cycle.easing).toBe("ease-in-out");
        // Gentle: full strength at the top, never below half at the bottom.
        expect(Math.max(...cycle.opacities)).toBe(1);
        const lowest = Math.min(...cycle.opacities);
        expect(lowest).toBeGreaterThanOrEqual(0.5);
        expect(lowest).toBeLessThanOrEqual(0.7);
        // Calm: no jump between neighbouring frames, as a blink or a step would make.
        for (let i = 1; i < cycle.opacities.length; i++)
          expect(
            Math.abs(cycle.opacities[i] - cycle.opacities[i - 1]),
          ).toBeLessThan(0.05);
      }
    } finally {
      await page.close();
    }
  });
});
