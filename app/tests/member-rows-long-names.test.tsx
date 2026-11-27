import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Browser, Page } from "playwright-core";
import { compile } from "tailwindcss";
import { still } from "./page-still";

/**
 * A long name and a long address in a list of people, in a real browser, in light and dark, wide
 * and on a phone: Organization settings' Members and Invitations, Admin's People and a team's
 * people. Every row
 * keeps its words inside its own column, never drawn under its Role, Remove or switch, and every
 * control stays inside the row and on screen. Drawn from member-rows-long-names.fixture.tsx,
 * styled by the app's stylesheet, and the page never scrolls sideways.
 *
 *   OPENBOT_APP_BROWSER=1 bun test app/tests/member-rows-long-names.test.tsx
 *
 * Chromium by default, as CI has it. OPENBOT_APP_ENGINES=chromium,webkit adds WebKit. With
 * OPENBOT_APP_SHOTS=<dir> each screen is saved as <screen>-<engine>-<theme>-<width>.png.
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
const THEMES = ["light", "dark"] as const;
const WINDOWS = [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
];
const SCREENS = ["organization", "people", "team"] as const;
const NAMES = [
  "Dana Whitfield",
  "Sam Ortiz",
  "Alexandria Montgomery-Fitzwilliam",
  "Bartholomew-Wolfeschlegelsteinhausenbergerdorff",
];
/** Organization settings also lists an invitation, named by its long address. */
const INVITED =
  "maximilian.featherstonehaugh-cholmondeley@northwind-freight-logistics.example";
const namesOn = (screen: (typeof SCREENS)[number]) =>
  screen === "organization" ? [...NAMES, INVITED] : NAMES;

async function bundle(): Promise<string> {
  const built = await Bun.build({
    entrypoints: [join(import.meta.dir, "member-rows-long-names.fixture.tsx")],
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
  screen: (typeof SCREENS)[number],
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
  // Every row is drawn once the last one is.
  await page
    .locator("[data-slot=item-title]", { hasText: "Bartholomew" })
    .first()
    .waitFor();
  const classes = await page.evaluate(() =>
    [...document.querySelectorAll("[class]")].flatMap((element) => [
      ...element.classList,
    ]),
  );
  await page.addStyleTag({ content: await stylesheet([...new Set(classes)]) });
  await page.evaluate(() => document.fonts.ready);
  await still(page);
  return page;
}

/**
 * Each person's row: where its words are drawn that the eye can see (clipped by any box that hides
 * what overflows it), against its controls and its own edges.
 */
function measure(names: string[]) {
  type Box = { left: number; top: number; right: number; bottom: number };
  const clip = (box: Box, by: Box): Box => ({
    left: Math.max(box.left, by.left),
    top: Math.max(box.top, by.top),
    right: Math.min(box.right, by.right),
    bottom: Math.min(box.bottom, by.bottom),
  });
  const empty = (box: Box) =>
    box.right - box.left < 0.5 || box.bottom - box.top < 0.5;
  const meets = (a: Box, b: Box) =>
    !empty(clip(a, b)) && a.left < b.right - 1 && b.left < a.right - 1;
  const rows = [...document.querySelectorAll("[data-slot=item]")].filter(
    (row) => {
      const title = row.querySelector("[data-slot=item-title]");
      return names.some((name) => title?.textContent?.includes(name));
    },
  );
  const problems: string[] = [];
  for (const row of rows) {
    const who =
      row.querySelector("[data-slot=item-title]")?.textContent ?? "a row";
    const rowBox = row.getBoundingClientRect();
    const content = row.querySelector("[data-slot=item-content]");
    const actions = row.querySelector("[data-slot=item-actions]");
    const actionsBox = actions?.getBoundingClientRect();
    if (actionsBox) {
      if (
        actionsBox.left < rowBox.left - 1 ||
        actionsBox.right > rowBox.right + 1
      )
        problems.push(`${who}: its controls leave the row`);
      if (actionsBox.right > innerWidth)
        problems.push(`${who}: its controls are off screen`);
    }
    const walker = document.createTreeWalker(
      content ?? row,
      NodeFilter.SHOW_TEXT,
    );
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!node.textContent?.trim()) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      for (const rect of range.getClientRects()) {
        let seen: Box = rect;
        for (
          let box = node.parentElement;
          box && box !== row.parentElement;
          box = box.parentElement
        ) {
          if (getComputedStyle(box).overflowX !== "visible")
            seen = clip(seen, box.getBoundingClientRect());
        }
        if (empty(seen)) continue;
        if (seen.right > rowBox.right + 1 || seen.left < rowBox.left - 1)
          problems.push(`${who}: "${node.textContent}" leaves the row`);
        if (actionsBox && meets(seen, actionsBox))
          problems.push(
            `${who}: "${node.textContent}" is drawn under its controls`,
          );
      }
    }
  }
  return {
    rows: rows.length,
    problems: [...new Set(problems)],
    sideways:
      document.documentElement.scrollWidth > innerWidth ||
      document.body.scrollWidth > innerWidth,
  };
}

describe.skipIf(!asked)("a long name in a list of people", () => {
  for (const engine of engines)
    for (const theme of THEMES)
      for (const window of WINDOWS)
        for (const screen of SCREENS) {
          test(`${screen}: words stay clear of the controls, in ${engine}, ${theme}, ${window.width}px`, async () => {
            const page = await open(engine, theme, window, screen);
            const names = namesOn(screen);
            const seen = await page.evaluate(measure, names);
            if (shots) {
              mkdirSync(shots, { recursive: true });
              await page.screenshot({
                path: join(
                  shots,
                  `${screen}-${engine}-${theme}-${window.width}.png`,
                ),
                fullPage: true,
              });
            }
            expect(seen.rows).toBe(names.length);
            expect(seen.problems).toEqual([]);
            expect(seen.sideways).toBe(false);
            await page.close();
          }, 60_000);
        }
});
