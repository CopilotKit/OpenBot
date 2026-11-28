import { afterAll, beforeAll, describe, expect } from "bun:test";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Browser, Page } from "playwright-core";
import { compile } from "tailwindcss";
import { test } from "./renderer-crash";

/**
 * FOUND IN DOGFOODING. OpenBot Desktop on a Mac set to English (United Kingdom), with Dictation on for
 * English (United Kingdom) and English (United States), said "This computer can't take dictation in
 * your language." The Mac's recognizer has no English (United Kingdom) on the device, and OpenBot
 * asked for nothing else. It now listens in English (United States), and when no language is on the
 * device it says which language and where to add it.
 *
 * Rendered in a real browser, in the engine the Mac window draws with (WebKit) and in Chromium,
 * because the page's language is the browser's own `navigator.language`, set here by the browser's
 * locale, and its names for languages are the engine's. The composer is the real component, bundled
 * from the fixture beside this file, with the desktop app faked by its channel contract.
 *
 *   OPENBOT_APP_BROWSER=1 bun test app/tests/composer-dictation-language.test.tsx
 *
 * Chromium by default, as CI has it. OPENBOT_APP_ENGINES=chromium,webkit adds WebKit. With
 * OPENBOT_APP_SHOTS=<dir> each state is saved as dictation-fallback-<engine>-<theme>-<case>.png.
 */
const asked = process.env.OPENBOT_APP_BROWSER === "1";
const shots = process.env.OPENBOT_APP_SHOTS;
const engines = (process.env.OPENBOT_APP_ENGINES ?? "chromium")
  .split(",")
  .map((engine) => engine.trim())
  .filter((engine) => engine === "chromium" || engine === "webkit") as (
  | "chromium"
  | "webkit"
)[];

const APP = join(import.meta.dir, "..");
const ORIGIN = "http://openbot.test";
/** The desktop app's dictation runs on macOS and Windows; the browsers on Linux CI say they are a Mac. */
const MAC =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)";
const NONE =
  "This Mac can't take dictation in English (United Kingdom). Turn on Dictation and add the language in System Settings, under Keyboard, then try again.";

async function bundle(): Promise<string> {
  const built = await Bun.build({
    entrypoints: [
      join(import.meta.dir, "composer-dictation-language.fixture.tsx"),
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

let script = "";
const browsers = new Map<string, Browser>();

async function browserFor(name: "chromium" | "webkit"): Promise<Browser> {
  let browser = browsers.get(name);
  if (!browser) {
    const playwright = await import("playwright-core");
    browser =
      name === "chromium"
        ? // The CI job installs full Chromium without the headless shell.
          await playwright.chromium.launch({ channel: "chromium" })
        : await playwright.webkit.launch();
    browsers.set(name, browser);
  }
  return browser;
}

beforeAll(async () => {
  if (asked) script = await bundle();
}, 120_000);

afterAll(async () => {
  await Promise.all([...browsers.values()].map((browser) => browser.close()));
});

/** Every class the page uses now, so the stylesheet covers what has just shown. */
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

async function open(
  engine: "chromium" | "webkit",
  which: "fallback" | "none",
  theme: "light" | "dark",
) {
  const browser = await browserFor(engine);
  const page = await browser.newPage({
    viewport: { width: 760, height: 360 },
    userAgent: MAC,
    locale: "en-GB",
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
  await page.goto(`${ORIGIN}/?case=${which}&theme=${theme}`);
  await page
    .getByRole("button", { name: "Dictate a message" })
    .waitFor({ timeout: 8000 });
  await style(page);
  return page;
}

/** The languages the page asked the desktop app about, and the one it started listening in. */
function asks(page: Page) {
  return page.evaluate(() => {
    const calls = (
      window as unknown as {
        shellCalls: { command: string; args?: Record<string, unknown> }[];
      }
    ).shellCalls;
    return {
      available: calls
        .filter((call) => call.command.endsWith("|speech_available"))
        .map((call) => call.args?.language),
      start: calls.find((call) => call.command.endsWith("|speech_start"))?.args
        ?.language,
    };
  });
}

describe.skipIf(!asked)(
  "dictation on a Mac without the page's language",
  () => {
    for (const engine of engines) {
      test(`${engine}: the microphone listens in English (United States), with no notice`, async () => {
        const page = await open(engine, "fallback", "light");
        try {
          expect(await page.evaluate(() => navigator.language)).toBe("en-GB");
          await page.getByRole("button", { name: "Dictate a message" }).click();
          await page
            .getByRole("button", { name: "Stop dictation" })
            .waitFor({ timeout: 8000 });
          await page
            .getByText("book a table for two")
            .waitFor({ timeout: 8000 });
          expect(await page.getByRole("alert").count()).toBe(0);
          expect(await asks(page)).toEqual({
            available: ["en-GB", "en-US"],
            start: "en-US",
          });
          if (shots) {
            await style(page);
            mkdirSync(shots, { recursive: true });
            await page.screenshot({
              path: join(
                shots,
                `dictation-fallback-${engine}-light-listening.png`,
              ),
            });
          }
        } finally {
          await page.close();
        }
      }, 60_000);

      for (const theme of ["light", "dark"] as const)
        test(`${engine} (${theme}): with no language on the device it says which, and where to add it`, async () => {
          const page = await open(engine, "none", theme);
          try {
            await page
              .getByRole("button", { name: "Dictate a message" })
              .click();
            const alert = page.getByRole("alert");
            await alert.waitFor({ timeout: 8000 });
            expect(await alert.textContent()).toBe(NONE);
            expect((await asks(page)).start).toBeUndefined();
            await style(page);
            // The notice reads whole: on screen, inside the page's width.
            const box = await alert.boundingBox();
            expect(box).not.toBeNull();
            expect(box?.x ?? -1).toBeGreaterThanOrEqual(0);
            expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(760);
            if (shots) {
              mkdirSync(shots, { recursive: true });
              await page.screenshot({
                path: join(
                  shots,
                  `dictation-fallback-${engine}-${theme}-none.png`,
                ),
              });
            }
          } finally {
            await page.close();
          }
        }, 60_000);
    }
  },
);
