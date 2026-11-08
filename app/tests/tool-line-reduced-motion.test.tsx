import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { Browser, Page } from "playwright-core";
import { renderToStaticMarkup } from "react-dom/server";
import { ProgressRow } from "../src/components/channels/progress-row";
import { ToolLine } from "../src/components/channels/tool-line";

/**
 * A running step's words stay readable when the operating system asks for reduced motion.
 *
 * The running shimmer paints a gradient through the glyphs and makes their own fill transparent.
 * The reduced-motion branch dropped the gradient and left the fill transparent, so on a computer
 * with animations turned off (Windows with "Animation effects" off, macOS with "Reduce motion")
 * every running step showed only its caret: "Asked you · Which city should I search" was blank.
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
  test("every running label is drawn in its own tone, without the sweep", async () => {
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
        // The same muted tone the sweep is drawn in, not the darker colour of what holds it.
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

  test("with motion allowed the label still sweeps through a transparent fill", async () => {
    const page = await open("no-preference");
    try {
      for (const line of await painted(page)) {
        expect(line.fill).toBe(TRANSPARENT);
        expect(line.background).toContain("linear-gradient");
        expect(line.animation).toBe("tool-line-sweep");
      }
    } finally {
      await page.close();
    }
  });
});
