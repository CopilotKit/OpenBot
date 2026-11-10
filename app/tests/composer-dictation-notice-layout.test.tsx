import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Browser, Page } from "playwright-core";
import { compile } from "tailwindcss";

/**
 * The microphone's notice never moves the message box and never lands on anything. Home centres the
 * box in the page, so a notice drawn above it in the flow pushed the box down by half its height
 * while it showed: 16px for "OpenBot couldn't find a microphone. Connect one, then try again.", seen
 * on Windows with no microphone. Drawn over the space above the box instead, it sat on the starter
 * tasks a new account sees there. In a conversation the box is pinned to the bottom and the notice
 * grows upward.
 *
 * Rendered in a real Chromium, because where the box lands is the browser's layout. The composer is
 * the real component, bundled from the fixture beside this file, in the Desktop window (the desktop
 * app faked by its channel contract) on a computer with no microphone; the stylesheet is the app's
 * own `styles.css` built by Tailwind for exactly the classes on the page.
 *
 *   OPENBOT_APP_BROWSER=1 bun test app/tests/composer-dictation-notice-layout.test.tsx
 *
 * With OPENBOT_APP_SHOTS=<dir> it also saves Home before and after the notice, with and without the
 * starter tasks, light and dark.
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

async function open(
  layout: "home" | "thread",
  theme: "light" | "dark",
  chips = false,
) {
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
  await page.goto(
    `${ORIGIN}/?layout=${layout}&theme=${theme}${chips ? "&chips=1" : ""}`,
  );
  await page
    .getByRole("button", { name: "Dictate a message" })
    .waitFor({ timeout: 8000 });
  if (chips)
    await page
      .getByRole("region", { name: "Starter tasks" })
      .waitFor({ timeout: 8000 });
  await style(page);
  return page;
}

type Rect = { top: number; bottom: number; left: number; right: number };

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

/**
 * Everything on Home the notice could land on, and the notice itself: the greeting, the starter
 * tasks' row, the box and the hint under it.
 */
function regions(page: Page) {
  return page.evaluate(() => {
    const rect = (element: Element | null | undefined) => {
      if (!element) return null;
      const { top, bottom, left, right } = element.getBoundingClientRect();
      return { top, bottom, left, right };
    };
    const hint = [...document.querySelectorAll("p")].find((p) =>
      p.textContent?.startsWith("OpenBot picks the right Bot"),
    );
    return {
      notice: rect(document.querySelector('[role="alert"]')),
      others: {
        greeting: rect(document.querySelector("h1")),
        tasks: rect(document.querySelector('[aria-label="Starter tasks"]')),
        box: rect(document.querySelector('form[data-slot="composer"]')),
        hint: rect(hint),
      },
    };
  });
}

const overlaps = (a: Rect, b: Rect) =>
  a.top < b.bottom && b.top < a.bottom && a.left < b.right && b.left < a.right;

/** The notice shown: the microphone pressed, and the desktop app's answer drawn and styled. */
async function showNotice(page: Page) {
  await page.getByRole("button", { name: "Dictate a message" }).click();
  await page.getByRole("alert").waitFor({ timeout: 8000 });
  expect(await page.getByRole("alert").textContent()).toBe(NOTICE);
  await style(page);
}

describe.skipIf(!asked)("the microphone's notice", () => {
  for (const chips of [false, true])
    for (const theme of ["light", "dark"] as const) {
      const name = `home${chips ? "-tasks" : ""}-${theme}`;
      test(`on Home${chips ? " with the starter tasks" : ""} (${theme}) overlaps nothing and leaves the box where it was`, async () => {
        const page = await open("home", theme, chips);
        try {
          const before = await box(page);
          if (shots) {
            mkdirSync(shots, { recursive: true });
            await page.screenshot({ path: join(shots, `${name}-idle.png`) });
          }
          await showNotice(page);
          const after = await box(page);
          if (shots)
            await page.screenshot({ path: join(shots, `${name}-notice.png`) });
          expect(before).not.toBeNull();
          expect(after).toEqual(before);
          const { notice, others } = await regions(page);
          expect(notice).not.toBeNull();
          if (chips) expect(others.tasks).not.toBeNull();
          const landed = Object.entries(others)
            .filter(
              (entry): entry is [string, Rect] =>
                entry[1] !== null &&
                notice !== null &&
                overlaps(notice, entry[1]),
            )
            .map(([what]) => what);
          expect(landed).toEqual([]);
          // Between what is above it and the box: under the tasks (or the greeting), over the box.
          const above = others.tasks ?? others.greeting;
          expect(notice?.top ?? 0).toBeGreaterThanOrEqual(above?.bottom ?? 0);
          expect(notice?.bottom ?? 0).toBeLessThanOrEqual(others.box?.top ?? 0);
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
