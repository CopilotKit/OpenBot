import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Browser, Page } from "playwright-core";
import { compile } from "tailwindcss";

/**
 * Removing somebody on a self-hosted OpenBot that keeps one shared organization and lets people
 * create more, in a real browser, in light and dark, wide and on a phone: Admin, People's Remove
 * dialog, and Identity providers' SCIM row saying what deprovisioning does.
 *
 * A self-hosted person has no organization of their own, so neither promises one: both say the
 * person keeps any other organization they're in. Drawn from admin-people-remove-layout.fixture.tsx,
 * styled by the app's stylesheet: the page never scrolls sideways, the dialog stays inside the
 * window with its words whole, and the SCIM row's sentence stays inside its row.
 *
 *   OPENBOT_APP_BROWSER=1 bun test app/tests/admin-people-remove-layout.test.tsx
 *
 * Chromium by default, as CI has it. OPENBOT_APP_ENGINES=chromium,webkit adds WebKit. With
 * OPENBOT_APP_SHOTS=<dir> each screen is saved as <screen>-<engine>-<theme>-<width>.png.
 * OPENBOT_APP_BEFORE=1 checks the layout alone, for a checkout from before the words changed.
 */
const asked = process.env.OPENBOT_APP_BROWSER === "1";
const shots = process.env.OPENBOT_APP_SHOTS;
const before = process.env.OPENBOT_APP_BEFORE === "1";
const engines = (process.env.OPENBOT_APP_ENGINES ?? "chromium")
  .split(",")
  .map((engine) => engine.trim())
  .filter((engine) => engine === "chromium" || engine === "webkit") as (
  | "chromium"
  | "webkit"
)[];

const APP = join(import.meta.dir, "..");
const ORIGIN = "http://openbot.test";
const THEMES = ["light", "dark"] as const;
const WINDOWS = [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
];

async function bundle(): Promise<string> {
  const built = await Bun.build({
    entrypoints: [
      join(import.meta.dir, "admin-people-remove-layout.fixture.tsx"),
    ],
    target: "browser",
    external: ["maplibre-gl"],
    // `@/lib/marks` is Vite's `import.meta.glob`, so no brand marks, as in the other browser tests.
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
    define: {
      "process.env.NODE_ENV": JSON.stringify("production"),
      "import.meta.env.DEV": "false",
      "import.meta.env.PROD": "true",
      "import.meta.env.MODE": JSON.stringify("production"),
    },
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

let script: string;
if (asked) script = await bundle();
const browsers: Browser[] = [];

afterAll(async () => {
  await Promise.all(browsers.map((browser) => browser.close()));
});

async function open(
  name: "chromium" | "webkit",
  theme: (typeof THEMES)[number],
  window: { width: number; height: number },
  screen: "people" | "scim",
): Promise<Page> {
  const playwright = await import("playwright-core");
  const engine = playwright[name];
  const browser =
    name === "chromium"
      ? // The CI job installs full Chromium without the headless shell.
        await engine.launch({ channel: "chromium" })
      : await engine.launch();
  browsers.push(browser);
  const page = await browser.newPage({
    viewport: window,
    colorScheme: theme,
    reducedMotion: "reduce",
  });
  page.on("pageerror", (error) => console.error(error));
  await page.route(`${ORIGIN}/**`, (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/app.js")
      return route.fulfill({ contentType: "text/javascript", body: script });
    if (url.pathname.includes("."))
      return route.fulfill({ status: 404, body: "" });
    return route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html lang="en" class="${theme}" style="color-scheme: ${theme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head><body><div id="root"></div><script type="module" src="/app.js"></script></body></html>`,
    });
  });
  await page.goto(`${ORIGIN}/?screen=${screen}`, {
    waitUntil: "domcontentloaded",
  });
  if (screen === "people") {
    await page
      .getByRole("button", { name: "Remove Samantha Ortiz-Villanueva" })
      .click();
    await page.getByRole("dialog").waitFor();
  } else {
    await page.getByText("SCIM provisioning").waitFor();
  }
  const classes = await page.evaluate(() =>
    [...document.querySelectorAll("[class]")].flatMap((element) => [
      ...element.classList,
    ]),
  );
  await page.addStyleTag({ content: await stylesheet([...new Set(classes)]) });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(400);
  return page;
}

async function shoot(page: Page, file: string) {
  if (!shots) return;
  mkdirSync(shots, { recursive: true });
  await page.screenshot({ path: join(shots, file), fullPage: true });
}

describe.skipIf(!asked)(
  "removing somebody, where people may create organizations",
  () => {
    for (const engine of engines)
      for (const theme of THEMES)
        for (const window of WINDOWS) {
          test(`People's Remove dialog fits and promises no own organization, in ${engine}, ${theme}, ${window.width}px`, async () => {
            const page = await open(engine, theme, window, "people");
            const seen = await page.evaluate(() => {
              const dialog = document.querySelector("[role=dialog]");
              const box = dialog?.getBoundingClientRect();
              // Words cut off at a box's edge: anything wider inside than it shows. A screen reader's
              // label is drawn 1px wide on purpose.
              const overflowing = [...(dialog?.querySelectorAll("*") ?? [])]
                .filter(
                  (element) =>
                    !element.classList.contains("sr-only") &&
                    element.scrollWidth > element.clientWidth + 1 &&
                    getComputedStyle(element).overflowX !== "visible",
                )
                .map(
                  (element) =>
                    `${element.tagName} ${element.getAttribute("class") ?? ""} ${element.scrollWidth}/${element.clientWidth}`,
                );
              return {
                text: dialog?.textContent ?? "",
                inside:
                  !!box &&
                  box.left >= 0 &&
                  box.top >= 0 &&
                  box.right <= innerWidth &&
                  box.bottom <= innerHeight,
                overflowing,
                sideways:
                  document.documentElement.scrollWidth > innerWidth ||
                  document.body.scrollWidth > innerWidth,
              };
            });
            await shoot(
              page,
              `people-remove-${engine}-${theme}-${window.width}.png`,
            );
            expect(seen.inside).toBe(true);
            expect(seen.overflowing).toEqual([]);
            expect(seen.sideways).toBe(false);
            expect(seen.text).toContain(
              "Remove Samantha Ortiz-Villanueva from Acme Freight?",
            );
            if (!before) {
              expect(seen.text).toContain(
                "They keep their account and any other organization they're in.",
              );
              expect(seen.text).not.toContain("their own organization");
            }
            await page.close();
          }, 60_000);

          test(`the SCIM row's deprovisioning sentence stays in its row, in ${engine}, ${theme}, ${window.width}px`, async () => {
            const page = await open(engine, theme, window, "scim");
            const seen = await page.evaluate(() => {
              const title = [...document.querySelectorAll("*")].find(
                (element) => element.textContent === "SCIM provisioning",
              );
              const row = title?.closest("[data-slot=item]");
              const rowBox = row?.getBoundingClientRect();
              const words = [...(row?.querySelectorAll("*") ?? [])].filter(
                (element) =>
                  element.children.length === 0 &&
                  (element.textContent ?? "").includes("Deprovisioning"),
              );
              return {
                text: row?.textContent ?? "",
                wordsInside: words.every((element) => {
                  const box = element.getBoundingClientRect();
                  return (
                    !!rowBox &&
                    box.left >= rowBox.left - 1 &&
                    box.right <= rowBox.right + 1
                  );
                }),
                found: words.length,
                sideways:
                  document.documentElement.scrollWidth > innerWidth ||
                  document.body.scrollWidth > innerWidth,
              };
            });
            await shoot(
              page,
              `scim-row-${engine}-${theme}-${window.width}.png`,
            );
            expect(seen.found).toBeGreaterThan(0);
            expect(seen.wordsInside).toBe(true);
            expect(seen.sideways).toBe(false);
            if (!before) {
              expect(seen.text).toContain(
                "They keep any other organization they're in.",
              );
              expect(seen.text).not.toContain("own organization");
            }
            await page.close();
          }, 60_000);
        }
  },
);
