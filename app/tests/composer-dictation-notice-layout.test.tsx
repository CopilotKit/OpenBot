import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Browser, Page } from "playwright-core";
import { compile } from "tailwindcss";

/**
 * The microphone's notice never moves the message box. Home centres the box in the page, so a notice
 * drawn above it in the flow pushed the box down by half its height while it showed: 16px for
 * "OpenBot couldn't find a microphone. Connect one, then try again.", seen on Windows with no
 * microphone. In a conversation the box is pinned to the bottom and the notice grows upward.
 *
 * Rendered in a real Chromium, because where the box lands is the browser's layout. The composer is
 * the real component, bundled from the fixture beside this file, in the Desktop window (the desktop
 * app faked by its channel contract) on a computer with no microphone; the stylesheet is the app's
 * own `styles.css` built by Tailwind for exactly the classes on the page.
 *
 *   OPENBOT_APP_BROWSER=1 bun test app/tests/composer-dictation-notice-layout.test.tsx
 *
 * With OPENBOT_APP_SHOTS=<dir> it also saves Home before and after the notice, light and dark.
 */
const asked = process.env.OPENBOT_APP_BROWSER === "1";
const shots = process.env.OPENBOT_APP_SHOTS;

const APP = join(import.meta.dir, "..");
const ORIGIN = "http://openbot.test";
const NOTICE =
  "OpenBot couldn't find a microphone. Connect one, then try again.";
/** The desktop app's dictation runs on macOS and Windows; Chromium on Linux CI says it is a Mac. */
const MAC =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

async function bundle(): Promise<string> {
  const built = await Bun.build({
    entrypoints: [
      join(import.meta.dir, "composer-dictation-notice.fixture.tsx"),
    ],
    target: "browser",
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
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

/** Every class the page uses now, so the stylesheet covers the notice once it shows. */
async function style(page: Page) {
  const classes = await page.evaluate(() => [
    ...new Set(
      [...document.querySelectorAll("[class]")].flatMap((element) => [
        ...element.classList,
      ]),
    ),
  ]);
  await page.addStyleTag({ content: await stylesheet(classes) });
}

async function open(layout: "home" | "thread", theme: "light" | "dark") {
  const page = await browser.newPage({
    viewport: { width: 1000, height: 760 },
    userAgent: MAC,
  });
  page.on("pageerror", (error) => console.error(error));
  await page.route(`${ORIGIN}/**`, (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/")
      return route.fulfill({
        contentType: "text/html",
        body: '<!doctype html><html lang="en"><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module" src="/composer.js"></script></body></html>',
      });
    if (path === "/composer.js")
      return route.fulfill({ contentType: "text/javascript", body: script });
    return route.fulfill({ status: 404 });
  });
  await page.goto(`${ORIGIN}/?layout=${layout}&theme=${theme}`);
  await page
    .getByRole("button", { name: "Dictate a message" })
    .waitFor({ timeout: 8000 });
  await style(page);
  return page;
}

/** Where the message box is, once the page has drawn. */
function box(page: Page) {
  return page.evaluate(async () => {
    await new Promise((done) =>
      requestAnimationFrame(() => requestAnimationFrame(done)),
    );
    const form = document.querySelector('form[data-slot="composer"]');
    const rect = form?.getBoundingClientRect();
    return rect ? { top: rect.top, height: rect.height } : null;
  });
}

/** The notice shown: the microphone pressed, and the desktop app's answer drawn and styled. */
async function showNotice(page: Page) {
  await page.getByRole("button", { name: "Dictate a message" }).click();
  await page.getByText(NOTICE).waitFor({ timeout: 8000 });
  await style(page);
}

describe.skipIf(!asked)("the microphone's notice", () => {
  for (const theme of ["light", "dark"] as const) {
    test(`on Home (${theme}) leaves the centred message box where it was`, async () => {
      const page = await open("home", theme);
      try {
        const before = await box(page);
        if (shots) {
          mkdirSync(shots, { recursive: true });
          await page.screenshot({
            path: join(shots, `home-${theme}-idle.png`),
          });
        }
        await showNotice(page);
        const after = await box(page);
        if (shots)
          await page.screenshot({
            path: join(shots, `home-${theme}-notice.png`),
          });
        expect(before).not.toBeNull();
        expect(after).toEqual(before);
        // Drawn above the box and clear of it, not under it or over it.
        const notice = await page.getByText(NOTICE).boundingBox();
        expect(notice).not.toBeNull();
        expect((notice?.y ?? 0) + (notice?.height ?? 0)).toBeLessThanOrEqual(
          before?.top ?? 0,
        );
      } finally {
        await page.close();
      }
    }, 60_000);
  }

  test("in a conversation leaves the box pinned where it was", async () => {
    const page = await open("thread", "light");
    try {
      const before = await box(page);
      await showNotice(page);
      expect(await box(page)).toEqual(before);
    } finally {
      await page.close();
    }
  }, 60_000);
});
