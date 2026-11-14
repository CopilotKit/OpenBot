import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { BotBrowserApiState } from "@openbot/shared/bot-browser";
import type { Browser, Page } from "playwright-core";
import { compile } from "tailwindcss";

/**
 * Record is on screen with the Bot's page, in a window of any width.
 *
 * A person who took control of a Bot's browser to record a task could not find Record. In the full-size view "Record a
 * task" was a column beside the Bot's screen from 1024px, and under the screen in anything narrower, which is where
 * OpenBot Desktop's window opens (1000px). There the page took the window's whole width at its own shape, so Record
 * began below the bottom edge, and scrolling with the pointer over the Bot's page scrolled that page, not the view.
 * The page now takes the height Record leaves, and Record lays out in two columns where it is under the page.
 *
 * Rendered in a real browser, because how tall a column of flexible boxes comes out is the browser's layout to decide.
 * The view is the real `ComputerView`, opened full size, with the app's stylesheet. The server's answers are served to
 * it as routes: a person holding control of a Bot's browser that is open on one page.
 *
 *   OPENBOT_APP_BROWSER=1 bun test app/tests/bot-screen-record-layout.test.tsx
 *
 * With OPENBOT_APP_SHOTS=<dir> it also saves each window as bot-screen-record-<width>x<height>.png.
 */
const asked = process.env.OPENBOT_APP_BROWSER === "1";
const shots = process.env.OPENBOT_APP_SHOTS;

const APP = join(import.meta.dir, "..");
const ORIGIN = "http://openbot.test";
const BOT = "fernhill-guide";

/**
 * OpenBot Desktop's window as it opens and at its smallest (`width`, `height`, `minWidth` and `minHeight` in
 * desktop/src-tauri/tauri.conf.json), a width between them, a phone, and a window wide enough for the column.
 */
const NARROW = [
  { width: 1000, height: 800 },
  { width: 800, height: 800 },
  { width: 720, height: 560 },
  { width: 390, height: 844 },
] as const;
const WIDE = { width: 1280, height: 800 } as const;

/** A 1x1 PNG: the picture the Computer draws until the live screen connects. */
const PIXEL =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

/** The Bot's browser while the person drives it, as the server answers for them (`botBrowserApiPaths.state`). */
const HELD: BotBrowserApiState = {
  open: true,
  tabs: [
    {
      id: "tab-1",
      url: "https://example.com/",
      title: "Example Domain",
      active: true,
    },
  ],
  recorder: {
    connected: false,
    phase: "idle",
    actions: 0,
    narration: "external",
  },
  mine: true,
  recordingIsMine: false,
} as BotBrowserApiState;

async function bundle(): Promise<string> {
  const built = await Bun.build({
    entrypoints: [
      join(import.meta.dir, "bot-screen-record-layout.fixture.tsx"),
    ],
    target: "browser",
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
  });
  if (!built.success) throw new AggregateError(built.logs, "bundle failed");
  const script = built.outputs.find((output) => output.kind === "entry-point");
  if (!script) throw new Error("bundle has no entry point");
  return script.text();
}

/** The directory of an installed package, from the app or the repository root. */
function packageDir(name: string): string {
  const dir = [
    join(APP, "node_modules", name),
    join(APP, "..", "node_modules", name),
  ].find(existsSync);
  if (!dir) throw new Error(`no package ${name}`);
  return dir;
}

/** Where `@import "<package>[/<file>]"` lands, by the package's `style` export as Vite reads it. */
function packageStylesheet(id: string): string {
  const parts = id.split("/");
  const name = id.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
  const dir = packageDir(name);
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

/** The Bot's screen, opened full size in a window this size by a person who holds control. */
async function open(window: { width: number; height: number }): Promise<Page> {
  const page = await browser.newPage({ viewport: window });
  page.on("pageerror", (error) => console.error(error));
  const inter = join(packageDir("@fontsource-variable/inter"), "files");
  // The live screen's socket connects and sends no frame: the page keeps its shape without one.
  await page.routeWebSocket(/.*/, () => {});
  await page.route(`${ORIGIN}/**`, (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/")
      return route.fulfill({
        contentType: "text/html",
        body: `<!doctype html><html lang="en" class="light"><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module" src="/view.js"></script></body></html>`,
      });
    if (path === "/view.js")
      return route.fulfill({ contentType: "text/javascript", body: script });
    const font = join(inter, path.split("/").pop() ?? "");
    if (path.startsWith("/files/") && existsSync(font))
      return route.fulfill({ path: font });
    const computer = `/api/computers/${BOT}`;
    if (path === `${computer}/screenshot`)
      return route.fulfill({
        json: {
          base64: PIXEL,
          width: 1280,
          height: 800,
          capturedAt: new Date(0).toISOString(),
          url: "https://example.com/",
          title: "Example Domain",
        },
      });
    if (path === `${computer}/status`)
      return route.fulfill({ json: { state: "ready" } });
    if (path === `${computer}/control`)
      return route.fulfill({
        json: {
          holder: "human",
          since: new Date(0).toISOString(),
          requested: false,
        },
      });
    if (path === `${computer}/browser`) return route.fulfill({ json: HELD });
    return route.fulfill({ status: 404, json: { error: "not found" } });
  });
  await page.goto(`${ORIGIN}/`);
  await page
    .getByRole("button", { name: "Open the Bot's screen full size" })
    .click();
  const view = page.getByRole("dialog", { name: "The Bot's screen" });
  await view.getByRole("button", { name: "Record", exact: true }).waitFor();
  const classes = await page.evaluate(() =>
    [...document.querySelectorAll("[class]")].flatMap((element) => [
      ...element.classList,
    ]),
  );
  await page.addStyleTag({ content: await stylesheet([...new Set(classes)]) });
  await page.evaluate(() => document.fonts.ready);
  // The page is sized to the space it is given once that space has been measured (`useFittedWidth`).
  await page.waitForTimeout(300);
  return page;
}

/** Where Record and the Bot's page sit in the window, before anybody scrolls. */
async function measured(page: Page) {
  return page.evaluate(() => {
    const view = document.querySelector(
      '[aria-label="The Bot\'s screen"]',
    ) as HTMLElement;
    const box = (element: Element | null | undefined) => {
      const rect = (element as HTMLElement).getBoundingClientRect();
      return {
        top: Math.round(rect.top),
        bottom: Math.round(rect.bottom),
        left: Math.round(rect.left),
        right: Math.round(rect.right),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      };
    };
    const record = [...view.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Record",
    );
    return {
      window: { width: innerWidth, height: innerHeight },
      scrolled: view.scrollTop,
      record: box(record),
      taskName: box(view.querySelector('[aria-label="Task name"]')),
      wheel: box(
        [...view.querySelectorAll("button")].find(
          (button) => button.textContent?.trim() === "Hand back",
        ),
      ),
      // The Bot's page: the box the live screen is drawn in, at the browser's own shape.
      screen: box(view.querySelector('[style*="aspect-ratio"]')),
    };
  });
}

describe.skipIf(!asked)("Record in a Bot's full-size screen", () => {
  for (const window of NARROW) {
    test(`is on screen without scrolling in a ${window.width}x${window.height} window, under a page a person can work in`, async () => {
      const page = await open(window);
      try {
        if (shots) {
          mkdirSync(shots, { recursive: true });
          await page.screenshot({
            path: join(
              shots,
              `bot-screen-record-${window.width}x${window.height}.png`,
            ),
          });
        }
        const at = await measured(page);
        expect(at.scrolled).toBe(0);
        // Record, the task's name and Hand back are whole inside the window.
        for (const control of [at.record, at.taskName, at.wheel]) {
          expect(control.top).toBeGreaterThanOrEqual(0);
          expect(control.bottom).toBeLessThanOrEqual(at.window.height);
          expect(control.left).toBeGreaterThanOrEqual(0);
          expect(control.right).toBeLessThanOrEqual(at.window.width);
        }
        // Under the page, which is above them and still a screen to work in: never under 200px tall, and at least
        // half the window's width wherever the window is tall enough to give it that.
        expect(at.screen.bottom).toBeLessThanOrEqual(at.wheel.top);
        expect(at.screen.height).toBeGreaterThanOrEqual(200);
        if (window.height >= 800)
          expect(at.screen.width).toBeGreaterThanOrEqual(
            Math.min(window.width - 60, window.width / 2),
          );
      } finally {
        await page.close();
      }
    }, 60_000);
  }

  test(`stays a column beside the page in a ${WIDE.width}px window`, async () => {
    const page = await open(WIDE);
    try {
      if (shots) {
        mkdirSync(shots, { recursive: true });
        await page.screenshot({
          path: join(
            shots,
            `bot-screen-record-${WIDE.width}x${WIDE.height}.png`,
          ),
        });
      }
      const at = await measured(page);
      expect(at.record.left).toBeGreaterThan(at.screen.right);
      expect(at.record.bottom).toBeLessThanOrEqual(at.window.height);
      // The page has the window's height, less the browser's own bars.
      expect(at.screen.width).toBeGreaterThanOrEqual(780);
    } finally {
      await page.close();
    }
  }, 60_000);
});
