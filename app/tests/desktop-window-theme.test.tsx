import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Browser, Page } from "playwright-core";

/**
 * In OpenBot Desktop the window follows the system when OpenBot does, and is pinned to light or
 * dark only when the person chose one.
 *
 * Seen in OpenBot Desktop: the window was pinned to whatever the page showed, and a pinned window
 * answers the page's `prefers-color-scheme` with the pin. So an OpenBot set to System took the
 * system's light or dark when it opened and never saw it change.
 *
 * Desktop runs a script in OpenBot's page (`APP_THEME_PAGE` in desktop/src-tauri/src/main.rs) that
 * tells the window what the page shows. This runs that script, read from the Rust source, in a
 * real Chromium over the app's real `index.html` and theme provider, with the window's command
 * recorded in place of Tauri. What the window does with each report is `window_theme`, tested in
 * Rust.
 *
 *   OPENBOT_APP_BROWSER=1 bun test app/tests/desktop-window-theme.test.tsx
 */
const asked = process.env.OPENBOT_APP_BROWSER === "1";

const APP = join(import.meta.dir, "..");
const ORIGIN = "http://openbot.test";
const KEY = "openbot-theme-choice";

type Report = { dark: boolean; system?: boolean };

let browser: Browser;
let script: string;
let html: string;
/** Desktop's script, as it is in the shell's source. */
let windowScript: string;

beforeAll(async () => {
  if (!asked) return;
  const main = readFileSync(
    join(APP, "..", "desktop", "src-tauri", "src", "main.rs"),
    "utf8",
  );
  const found = main.match(/const APP_THEME_PAGE: &str = r#"([\s\S]*?)"#;/);
  if (!found) throw new Error("main.rs has no APP_THEME_PAGE");
  windowScript = found[1];
  const built = await Bun.build({
    entrypoints: [join(import.meta.dir, "theme-follows-system.fixture.tsx")],
    target: "browser",
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
  });
  if (!built.success) throw new AggregateError(built.logs, "bundle failed");
  const entry = built.outputs.find((output) => output.kind === "entry-point");
  if (!entry) throw new Error("bundle has no entry point");
  script = await entry.text();
  html = readFileSync(join(APP, "index.html"), "utf8").replace(
    "/src/main.tsx",
    "/theme.js",
  );
  if (!html.includes("/theme.js"))
    throw new Error("index.html no longer has the shape this test reads");
  const { chromium } = await import("playwright-core");
  // The CI job installs full Chromium without the headless shell.
  browser = await chromium.launch({ channel: "chromium" });
}, 60_000);

afterAll(async () => {
  await browser?.close();
});

/**
 * OpenBot open in Desktop's window on a system set to `system`, with `chosen` saved by the Theme
 * setting. Desktop's script runs once the page has loaded, as the shell runs it.
 */
async function open(
  system: "light" | "dark",
  chosen: "light" | "dark" | null = null,
  page_ = html,
): Promise<Page> {
  const context = await browser.newContext({ colorScheme: system });
  const page = await context.newPage();
  page.on("pageerror", (error) => console.error(error));
  await page.route(`${ORIGIN}/**`, (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/")
      return route.fulfill({ contentType: "text/html", body: page_ });
    if (path === "/theme.js")
      return route.fulfill({ contentType: "text/javascript", body: script });
    return route.fulfill({ status: 404 });
  });
  await page.addInitScript(
    ([key, value]) => {
      if (value !== null) localStorage.setItem(key, value);
      const reports: Array<unknown> = [];
      Object.assign(window, {
        __reports: reports,
        __TAURI_INTERNALS__: {
          invoke: (command: string, args: unknown) => {
            if (command === "plugin:openbot-desktop|appearance")
              reports.push(args);
            return Promise.resolve();
          },
        },
      });
    },
    [KEY, chosen] as const,
  );
  await page.goto(`${ORIGIN}/`);
  await page.locator("[data-setting-shows]").waitFor({ timeout: 8000 });
  await page.evaluate(windowScript);
  return page;
}

function reports(page: Page): Promise<Report[]> {
  return page.evaluate(
    () => (window as unknown as { __reports: Report[] }).__reports,
  );
}

/** The window's last report, once there are `count` of them. */
async function report(page: Page, count: number): Promise<Report> {
  await page.waitForFunction(
    (wanted) =>
      (window as unknown as { __reports: unknown[] }).__reports.length >=
      wanted,
    count,
  );
  const all = await reports(page);
  expect(all).toHaveLength(count);
  return all[count - 1];
}

describe.skipIf(!asked)("OpenBot Desktop's window and the system", () => {
  test("an OpenBot following the system tells the window to follow it, and says when the system changes", async () => {
    const page = await open("dark");
    expect(await report(page, 1)).toEqual({ dark: true, system: true });
    await page.emulateMedia({ colorScheme: "light" });
    expect(await report(page, 2)).toEqual({ dark: false, system: true });
    await page.context().close();
  });

  test("a chosen Light or Dark pins the window, whatever the system is", async () => {
    const page = await open("dark", "light");
    expect(await report(page, 1)).toEqual({ dark: false, system: false });
    await page.getByRole("button", { name: "dark" }).click();
    expect(await report(page, 2)).toEqual({ dark: true, system: false });
    await page.context().close();
  });

  // The pinned window answers the page with its pin, so nothing the page shows changes here. Only
  // the choice does, and the window has to hear it to let go.
  test("going back to System lets the window go, though the page looks the same", async () => {
    const page = await open("dark", "dark");
    expect(await report(page, 1)).toEqual({ dark: true, system: false });
    await page.getByRole("button", { name: "system" }).click();
    expect(await report(page, 2)).toEqual({ dark: true, system: true });
    await page.context().close();
  });

  // An OpenBot from before it followed the system: no choice on its root, and its own light or dark.
  test("an OpenBot that names no choice keeps its window pinned", async () => {
    const page = await open("dark");
    await page.evaluate(() => {
      (window as unknown as { __reports: unknown[] }).__reports.length = 0;
      delete document.documentElement.dataset.themeChoice;
      document.documentElement.classList.remove("dark");
    });
    expect(await report(page, 1)).toEqual({ dark: false, system: false });
    await page.context().close();
  });
});
