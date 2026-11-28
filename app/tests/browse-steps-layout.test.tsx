import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Browser, BrowserType, Page } from "playwright-core";
import { compile } from "tailwindcss";

/**
 * A Bot's browse steps, opened in a real conversation in a real browser.
 *
 * Found in the 1.2.0-rc.6 Mac install test: opened, every field the Bot filled in said "Filled in
 * field" and nothing more. Each step now names the field or button it acted on, as the computer
 * resolved it, and never what was typed: not the email, and never the password. A field whose label
 * is far longer than the column stays on one line, cut short, and nothing scrolls sideways. In the
 * app's stylesheet, light and dark, at a laptop's width and a phone's.
 *
 *   OPENBOT_APP_BROWSER=1 bun test app/tests/browse-steps-layout.test.tsx
 *
 * Chromium by default. OPENBOT_APP_ENGINES=chromium,webkit adds WebKit, as CI has it. With
 * OPENBOT_APP_SHOTS=<dir> each state is saved as browse-steps-<engine>-<theme>-<width>.png.
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
const EMAIL = "sam@example.com";
const PASSWORD = "hunter2-SuperSecret!";

async function bundle(): Promise<string> {
  const built = await Bun.build({
    entrypoints: [join(import.meta.dir, "browse-steps-layout.fixture.tsx")],
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

const browsers = new Map<string, Browser>();
let script: string;

beforeAll(async () => {
  if (!asked) return;
  script = await bundle();
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

type Window = { width: number; height: number };

async function open(
  engine: string,
  theme: "light" | "dark",
  window: Window,
): Promise<Page> {
  const browser = browsers.get(engine);
  if (!browser) throw new Error(`no ${engine}`);
  const page = await browser.newPage({
    viewport: window,
    colorScheme: theme,
    reducedMotion: "reduce",
  });
  page.on("pageerror", (error) => console.error(error));
  const inter = join(packageDir("@fontsource-variable/inter"), "files");
  await page.route(`${ORIGIN}/**`, (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/steps.js")
      return route.fulfill({ contentType: "text/javascript", body: script });
    const font = join(inter, path.split("/").pop() ?? "");
    if (path.startsWith("/files/") && existsSync(font))
      return route.fulfill({ path: font });
    if (path.startsWith("/api/")) return route.fulfill({ status: 404 });
    return route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html lang="en" class="${theme}" style="color-scheme: ${theme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head><body><div id="root"></div><script type="module" src="/steps.js"></script></body></html>`,
    });
  });
  await page.goto(`${ORIGIN}/`);
  await page
    .getByRole("region", { name: "Conversation" })
    .waitFor({ timeout: 15_000 });
  await page.getByText("You're signed in.").waitFor({ timeout: 15_000 });
  const classes = await page.evaluate(() =>
    [...document.querySelectorAll("[class]")].flatMap((element) => [
      ...element.classList,
    ]),
  );
  await page.addStyleTag({
    content: await stylesheet([...new Set(classes)]),
  });
  await page.evaluate(() => document.fonts.ready);
  return page;
}

const WINDOWS: Window[] = [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
];

describe.skipIf(!asked)("a Bot's browse steps, opened", () => {
  for (const engine of engines)
    for (const theme of ["light", "dark"] as const)
      for (const window of WINDOWS) {
        const name = `${engine}-${theme}-${window.width}`;

        test(`name each field and button, never what was typed, in ${engine}, ${theme}, ${window.width}px`, async () => {
          const page = await open(engine, theme, window);
          try {
            await page
              .locator("summary", {
                hasText: "Browsed the-internet.herokuapp.com",
              })
              .click();
            const rows = page.locator("details[open] ol > li");
            await rows.first().waitFor({ timeout: 5_000 });
            if (shots) {
              mkdirSync(shots, { recursive: true });
              await page.screenshot({
                path: join(shots, `browse-steps-${name}.png`),
                fullPage: true,
              });
            }
            const lines = (await rows.allTextContents()).map((line) =>
              line.trim(),
            );
            expect(lines.slice(0, 4)).toEqual([
              "Opened pageThe Internet",
              "Inspected page",
              "Filled in fieldEmail address",
              "Filled in fieldPassword",
            ]);
            expect(lines[4]).toStartWith(
              "Filled in fieldTell us, in as much detail",
            );
            expect(lines[5]).toBe("Clicked on pageSign in");

            const shown = await page.evaluate(() => document.body.innerText);
            expect(shown).not.toContain(EMAIL);
            expect(shown).not.toContain(PASSWORD);
            expect(shown).not.toContain("Acme Widgets Ltd");

            // The long label stays on one line, cut short inside the column.
            expect(
              await page.evaluate(
                () => document.documentElement.scrollWidth > innerWidth,
              ),
            ).toBe(false);
            const long = rows.nth(4);
            expect((await long.boundingBox())?.height ?? 99).toBeLessThan(28);
            const detail = long.locator("span.truncate");
            const box = await detail.boundingBox();
            const row = await long.boundingBox();
            expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(
              (row?.x ?? 0) + (row?.width ?? 0) + 0.5,
            );
            // On a phone it is wider than the column, so it is cut short with an ellipsis.
            if (window.width < 500)
              expect(
                await detail.evaluate(
                  (element) => element.scrollWidth > element.clientWidth,
                ),
              ).toBe(true);
          } finally {
            await page.close();
          }
        }, 90_000);
      }
});
