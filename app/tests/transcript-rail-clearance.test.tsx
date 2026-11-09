import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Browser, Page } from "playwright-core";
import { compile } from "tailwindcss";

/**
 * The rail of turns beside a conversation never sits on the messages. Wherever it draws, the
 * column's text starts at least 24px to the right of its marks.
 *
 * The rail sits in the scroller's left margin, its marks 8px to 40px from the edge. The column is
 * 768px and centred, so its text starts 16px inside a margin of half of what is left over. With
 * the rail shown from a 768px scroller, the margin was nothing at 768px and under 40px until about
 * 850px, and the rail's marks drew over the first letters of the Bot's replies.
 *
 * Rendered in a real Chromium, because where the text lands beside the rail is the browser's
 * layout. The transcript is the real component, bundled from the fixture beside this file; the
 * stylesheet is the app's own `styles.css` built by Tailwind for exactly the classes on the page.
 * The window is swept through the widths around where the rail starts to draw.
 *
 *   OPENBOT_APP_BROWSER=1 bun test app/tests/transcript-rail-clearance.test.tsx
 *
 * With OPENBOT_APP_SHOTS=<dir> it also saves screenshots at 1280px, 900px and 800px wide.
 */
const asked = process.env.OPENBOT_APP_BROWSER === "1";
const shots = process.env.OPENBOT_APP_SHOTS;

const APP = join(import.meta.dir, "..");
const ORIGIN = "http://openbot.test";
/** The least room between the rail's marks and the column's text. */
const CLEARANCE = 24;
const LAST_REPLY = "Shall I draft the summary";

/** The fixture bundled for the browser. `@/lib/marks` is Vite's `import.meta.glob`, so no marks. */
async function bundle(): Promise<string> {
  const built = await Bun.build({
    entrypoints: [
      join(import.meta.dir, "transcript-rail-clearance.fixture.tsx"),
    ],
    target: "browser",
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    plugins: [
      {
        name: "no-marks",
        setup(build) {
          build.onResolve({ filter: /^@\/lib\/marks$/ }, () => ({
            path: "marks",
            namespace: "no-marks",
          }));
          build.onLoad({ filter: /.*/, namespace: "no-marks" }, () => ({
            contents: "export const markFor = () => null;",
            loader: "js",
          }));
        },
      },
    ],
  });
  if (!built.success) throw new AggregateError(built.logs, "bundle failed");
  const script = built.outputs.find((output) => output.kind === "entry-point");
  if (!script) throw new Error("bundle has no entry point");
  return script.text();
}

/** Where `@import "<package>[/<file>]"` lands, by the package's `style` export as Vite reads it. */
function packageStylesheet(id: string): string {
  const parts = id.split("/");
  const name = id.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
  const dir = [
    join(APP, "node_modules", name),
    join(APP, "..", "node_modules", name),
  ].find(existsSync);
  if (!dir) throw new Error(`no package for ${id}`);
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  const subpath = `.${id.slice(name.length)}`;
  const entry = pkg.exports?.[subpath];
  const file =
    typeof entry === "string"
      ? entry
      : (entry?.style ?? entry?.default ?? pkg.main ?? "index.css");
  return join(dir, file);
}

/** The app's stylesheet, built by Tailwind for these classes, as the app's build does. */
async function stylesheet(classes: string[]): Promise<string> {
  const tailwind = dirname(Bun.resolveSync("tailwindcss/package.json", APP));
  const entry = join(APP, "src", "styles.css");
  const compiler = await compile(readFileSync(entry, "utf8"), {
    base: dirname(entry),
    loadStylesheet: async (id, base) => {
      const path =
        id === "tailwindcss"
          ? join(tailwind, "index.css")
          : id.startsWith(".")
            ? join(base, id)
            : packageStylesheet(id);
      return { path, base: dirname(path), content: readFileSync(path, "utf8") };
    },
  });
  return compiler.build(classes);
}

let browser: Browser;
let script: string;

beforeAll(async () => {
  if (!asked) return;
  script = await bundle();
  const { chromium } = await import("playwright-core");
  // The CI job installs full Chromium without the headless shell.
  browser = await chromium.launch({ channel: "chromium" });
});

afterAll(async () => {
  await browser?.close();
});

/** The conversation open in a window this size, styled once it has drawn. */
async function open(width: number, height: number): Promise<Page> {
  const page = await browser.newPage({ viewport: { width, height } });
  page.on("pageerror", (error) => console.error(error));
  await page.route(`${ORIGIN}/**`, (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/")
      return route.fulfill({
        contentType: "text/html",
        body: '<!doctype html><html lang="en"><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module" src="/transcript.js"></script></body></html>',
      });
    if (path === "/transcript.js")
      return route.fulfill({ contentType: "text/javascript", body: script });
    return route.fulfill({ status: 404 });
  });
  await page.goto(`${ORIGIN}/`);
  await page.getByText(LAST_REPLY).waitFor({ timeout: 8000 });
  const classes = await page.evaluate(() => [
    ...new Set(
      [...document.querySelectorAll("[class]")].flatMap((element) => [
        ...element.classList,
      ]),
    ),
  ]);
  await page.addStyleTag({ content: await stylesheet(classes) });
  return page;
}

/** Whether the rail draws, its marks' right edge, and where the column's leftmost text starts. */
function measure(page: Page) {
  return page.evaluate(async () => {
    await new Promise((done) =>
      requestAnimationFrame(() => requestAnimationFrame(done)),
    );
    const rail = document.querySelector('nav[aria-label="Turns"]');
    const marks = [...document.querySelectorAll('[data-slot="rail-mark"]')];
    const shown = rail !== null && getComputedStyle(rail).display !== "none";
    const railRight = Math.max(
      ...marks.map((mark) => mark.getBoundingClientRect().right),
    );
    const column = document.querySelector(
      '[data-slot="message-scroller-content"]',
    );
    let textLeft = Number.POSITIVE_INFINITY;
    if (column) {
      const walker = document.createTreeWalker(column, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (!node.textContent?.trim()) continue;
        const range = document.createRange();
        range.selectNodeContents(node);
        for (const rect of range.getClientRects()) {
          if (rect.width > 0) textLeft = Math.min(textLeft, rect.left);
        }
      }
    }
    return { shown, railRight, textLeft };
  });
}

describe.skipIf(!asked)("the rail of turns beside a conversation", () => {
  test("wherever it draws, the Bot's text starts clear of its marks", async () => {
    const page = await open(1280, 800);
    try {
      const crowded: string[] = [];
      let drawn = 0;
      const widths = [];
      for (let width = 740; width <= 1040; width += 8) widths.push(width);
      widths.push(1280);
      for (const width of widths) {
        await page.setViewportSize({ width, height: 800 });
        const { shown, railRight, textLeft } = await measure(page);
        if (!shown) continue;
        drawn += 1;
        const gap = Math.round(textLeft - railRight);
        if (gap < CLEARANCE) crowded.push(`${width}px wide: ${gap}px`);
      }
      if (shots) {
        mkdirSync(shots, { recursive: true });
        for (const width of [1280, 900, 800]) {
          await page.setViewportSize({ width, height: 800 });
          await measure(page);
          await page.screenshot({ path: join(shots, `${width}.png`) });
        }
      }
      // It does draw where there is room, so the clearance above was measured, not skipped.
      expect(drawn).toBeGreaterThan(0);
      expect(crowded).toEqual([]);
    } finally {
      await page.close();
    }
  }, 60_000);
});
