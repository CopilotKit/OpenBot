import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Browser, Page } from "playwright-core";

/**
 * OpenBot follows the system's light or dark until a person chooses one of their own.
 *
 * Seen in OpenBot Desktop: with the Mac in dark, the setup screens were dark and Home was light,
 * because the app kept its own light or dark and never asked the system.
 *
 * Rendered in a real Chromium, because the system's setting is the browser's
 * `prefers-color-scheme` and its change event. The page is the app's real `index.html`, whose
 * inline script sets the theme before the first paint, with the app's real theme provider bundled
 * from the fixture beside this file in place of the app.
 *
 *   OPENBOT_APP_BROWSER=1 bun test app/tests/theme-follows-system.test.tsx
 */
const asked = process.env.OPENBOT_APP_BROWSER === "1";

const APP = join(import.meta.dir, "..");
const ORIGIN = "http://openbot.test";
const KEY = "openbot-theme-choice";
/** Where every release before the app followed the system saved its light or dark, on every visit. */
const LEGACY_KEY = "openbot-theme";

let browser: Browser;
let script: string;
/** The app's page, with the fixture in the app's place and a note of the theme at first paint. */
let html: string;

beforeAll(async () => {
  if (!asked) return;
  const built = await Bun.build({
    entrypoints: [join(import.meta.dir, "theme-follows-system.fixture.tsx")],
    target: "browser",
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
  });
  if (!built.success) throw new AggregateError(built.logs, "bundle failed");
  const entry = built.outputs.find((output) => output.kind === "entry-point");
  if (!entry) throw new Error("bundle has no entry point");
  script = await entry.text();
  const page = readFileSync(join(APP, "index.html"), "utf8");
  // Read where the body starts: after the head's script, before any module has run.
  html = page
    .replace(
      "<body>",
      `<body><script>window.__darkAtFirstPaint = document.documentElement.classList.contains("dark");</script>`,
    )
    .replace("/src/main.tsx", "/theme.js");
  if (!html.includes("__darkAtFirstPaint") || !html.includes("/theme.js"))
    throw new Error("index.html no longer has the shape this test reads");
  const { chromium } = await import("playwright-core");
  // The CI job installs full Chromium without the headless shell.
  browser = await chromium.launch({ channel: "chromium" });
}, 60_000);

afterAll(async () => {
  await browser?.close();
});

/** The app opened on a system set to `system`, with `stored` already saved in this browser under `key`. */
async function open(
  system: "light" | "dark",
  stored: string | null = null,
  key = KEY,
): Promise<Page> {
  const context = await browser.newContext({ colorScheme: system });
  const page = await context.newPage();
  page.on("pageerror", (error) => console.error(error));
  await page.route(`${ORIGIN}/**`, (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/")
      return route.fulfill({ contentType: "text/html", body: html });
    if (path === "/theme.js")
      return route.fulfill({ contentType: "text/javascript", body: script });
    return route.fulfill({ status: 404 });
  });
  if (stored !== null) {
    await page.addInitScript(
      ([key, value]) => {
        // Only what was there before the app opened: a reload keeps what the app saved since.
        if (!sessionStorage.getItem("seeded")) {
          sessionStorage.setItem("seeded", "1");
          localStorage.setItem(key, value);
        }
      },
      [key, stored] as const,
    );
  }
  await page.goto(`${ORIGIN}/`);
  await page.locator("[data-theme-choice]").waitFor({ timeout: 8000 });
  return page;
}

/** What the page shows: the theme at first paint, the theme now, and what the setting reads. */
function shown(page: Page) {
  return page.evaluate(
    ([key, legacyKey]) => {
      const root = document.documentElement;
      return {
        firstPaint: (window as unknown as { __darkAtFirstPaint: boolean })
          .__darkAtFirstPaint
          ? "dark"
          : "light",
        now: root.classList.contains("dark") ? "dark" : "light",
        colorScheme: root.style.colorScheme,
        choice: document
          .querySelector("[data-theme-choice]")
          ?.getAttribute("data-theme-choice"),
        stored: localStorage.getItem(key),
        legacy: localStorage.getItem(legacyKey),
      };
    },
    [KEY, LEGACY_KEY] as const,
  );
}

describe.skipIf(!asked)("the app follows the system's light or dark", () => {
  test("a dark system gives a dark app from the first paint, with nothing chosen", async () => {
    const page = await open("dark");
    expect(await shown(page)).toEqual({
      firstPaint: "dark",
      now: "dark",
      colorScheme: "dark",
      choice: "system",
      stored: null,
      legacy: null,
    });
    await page.context().close();
  });

  test("a light system gives a light app, with nothing chosen", async () => {
    const page = await open("light");
    expect(await shown(page)).toMatchObject({
      firstPaint: "light",
      now: "light",
      colorScheme: "light",
      choice: "system",
    });
    await page.context().close();
  });

  test("the app switches when the system does, without a reload", async () => {
    const page = await open("light");
    await page.evaluate(() => {
      (window as unknown as { __sameDocument: boolean }).__sameDocument = true;
    });
    await page.emulateMedia({ colorScheme: "dark" });
    await page.waitForFunction(() =>
      document.documentElement.classList.contains("dark"),
    );
    expect(await shown(page)).toMatchObject({
      now: "dark",
      colorScheme: "dark",
    });
    await page.emulateMedia({ colorScheme: "light" });
    await page.waitForFunction(
      () => !document.documentElement.classList.contains("dark"),
    );
    expect(await shown(page)).toMatchObject({
      now: "light",
      colorScheme: "light",
    });
    expect(
      await page.evaluate(
        () => (window as unknown as { __sameDocument: boolean }).__sameDocument,
      ),
    ).toBe(true);
    await page.context().close();
  });

  // Chosen in the Theme setting, which is the only thing that saves under this key.
  for (const [stored, system] of [
    ["light", "dark"],
    ["dark", "light"],
  ] as const) {
    test(`a chosen "${stored}" stays ${stored} on a ${system} system, and through a system change`, async () => {
      const page = await open(system, stored);
      expect(await shown(page)).toEqual({
        firstPaint: stored,
        now: stored,
        colorScheme: stored,
        choice: stored,
        stored,
        legacy: null,
      });
      await page.emulateMedia({ colorScheme: stored });
      await page.emulateMedia({ colorScheme: system });
      expect(await shown(page)).toMatchObject({ now: stored, choice: stored });
      await page.context().close();
    });
  }

  // Earlier releases saved a light or dark on every visit, so that value was never a choice.
  for (const [saved, system] of [
    ["light", "dark"],
    ["dark", "light"],
  ] as const) {
    test(`a "${saved}" an earlier release saved is no choice: a ${system} system gives a ${system} app`, async () => {
      const page = await open(system, saved, LEGACY_KEY);
      expect(await shown(page)).toEqual({
        firstPaint: system,
        now: system,
        colorScheme: system,
        choice: "system",
        stored: null,
        // Cleared, so it is not read again.
        legacy: null,
      });
      await page.emulateMedia({ colorScheme: saved });
      await page.waitForFunction(
        (dark) => document.documentElement.classList.contains("dark") === dark,
        saved === "dark",
      );
      expect(await shown(page)).toMatchObject({ now: saved, choice: "system" });
      await page.context().close();
    });
  }

  test("a choice made in the Theme setting outlasts what an earlier release saved", async () => {
    const page = await open("dark", "dark", LEGACY_KEY);
    await page.getByRole("button", { name: "light" }).click();
    await page.waitForFunction(
      () => !document.documentElement.classList.contains("dark"),
    );
    await page.reload();
    await page.locator("[data-theme-choice]").waitFor({ timeout: 8000 });
    expect(await shown(page)).toMatchObject({
      firstPaint: "light",
      now: "light",
      choice: "light",
      stored: "light",
      legacy: null,
    });
    await page.context().close();
  });

  test("choosing Light or Dark wins over the system and is kept; System follows it again", async () => {
    const page = await open("dark");
    await page.getByRole("button", { name: "light" }).click();
    await page.waitForFunction(
      () => !document.documentElement.classList.contains("dark"),
    );
    expect(await shown(page)).toMatchObject({
      now: "light",
      colorScheme: "light",
      choice: "light",
      stored: "light",
    });

    await page.reload();
    await page.locator("[data-theme-choice]").waitFor({ timeout: 8000 });
    expect(await shown(page)).toMatchObject({
      firstPaint: "light",
      now: "light",
      choice: "light",
    });

    await page.getByRole("button", { name: "system" }).click();
    await page.waitForFunction(() =>
      document.documentElement.classList.contains("dark"),
    );
    expect(await shown(page)).toMatchObject({
      now: "dark",
      choice: "system",
      stored: null,
    });

    await page.reload();
    await page.locator("[data-theme-choice]").waitFor({ timeout: 8000 });
    expect(await shown(page)).toMatchObject({
      firstPaint: "dark",
      now: "dark",
      choice: "system",
    });
    await page.context().close();
  });
});
