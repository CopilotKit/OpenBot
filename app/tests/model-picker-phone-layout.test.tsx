import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Browser, BrowserType, Page } from "playwright-core";
import { compile } from "tailwindcss";
import { still } from "./page-still";

/**
 * The composer's model picker names every model whole, on a phone as on a laptop.
 *
 * At a phone's width the popup shares the window between the models and the "Thinking" column,
 * and OpenBot's own model carries its Default tag: the model's name was cut to "GPT-6…." there.
 * Drawn in a real browser, because whether a name fits its row is the browser's layout to decide:
 * each model's name is read whole (nothing clipped across or down), the Default tag and the check
 * stay clear of it, and the popup fits the window, the page's 16px gutter from either side. In
 * light and dark, at 390 and at 1440.
 *
 *   OPENBOT_APP_BROWSER=1 bun test app/tests/model-picker-phone-layout.test.tsx
 *
 * Chromium by default, as CI has it. OPENBOT_APP_ENGINES=chromium,webkit adds WebKit. With
 * OPENBOT_APP_SHOTS=<dir> each is saved as model-picker-<engine>-<theme>-<width>.png.
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
  { width: 390, height: 844 },
  { width: 1440, height: 900 },
];

/** The vendored marks as data URIs, as Vite's `import.meta.glob` hands them to `@/lib/marks`. */
function marksModule(): string {
  const dir = join(APP, "..", "shared", "marks");
  const marks = Object.fromEntries(
    readdirSync(dir)
      .filter((file) => file.endsWith(".svg"))
      .map((file) => [
        file.replace(".svg", ""),
        `data:image/svg+xml;base64,${readFileSync(join(dir, file)).toString("base64")}`,
      ]),
  );
  return `const marks = ${JSON.stringify(marks)}; export const markFor = (id) => (id && marks[id]) || null;`;
}

async function bundle(): Promise<string> {
  const built = await Bun.build({
    entrypoints: [join(import.meta.dir, "model-picker-phone.fixture.tsx")],
    target: "browser",
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    plugins: [
      {
        name: "marks",
        setup(build) {
          build.onResolve({ filter: /^@\/lib\/marks$/ }, () => ({
            path: "marks",
            namespace: "marks",
          }));
          build.onLoad({ filter: /.*/, namespace: "marks" }, () => ({
            contents: marksModule(),
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

/** Styles what the page draws now: opening the popup drew classes the last sheet was not built for. */
async function restyle(page: Page) {
  const classes = await page.evaluate(() =>
    [...document.querySelectorAll("[class]")].flatMap((element) => [
      ...element.classList,
    ]),
  );
  await page.addStyleTag({ content: await stylesheet([...new Set(classes)]) });
  await still(page);
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

/** Each model row as drawn: its name whole or not, and whether the tag and check stay clear of it. */
async function measured(page: Page) {
  return page.evaluate(() => {
    const popup = document.querySelector("[data-slot=combobox-content]");
    const models = document.querySelector("[role=group][aria-label=Models]");
    const rows = [...(models?.querySelectorAll("[role=option]") ?? [])].map(
      (row) => {
        const name = row.querySelector("[data-slot=model-name]") as HTMLElement;
        const box = name.getBoundingClientRect();
        // Everything else drawn in the row: the Default tag, and the check of the model in use.
        const others = [...row.querySelectorAll("span, svg")]
          .filter((other) => other !== name && !name.contains(other))
          .filter((other) => !other.contains(name))
          .map((other) => other.getBoundingClientRect())
          .filter((rect) => rect.width > 0 && rect.left > box.left);
        return {
          name: name.textContent,
          // How many lines the name takes: a short one fits one, never "GPT-" over "6.1".
          lines: Math.round(
            box.height / Number.parseFloat(getComputedStyle(name).lineHeight),
          ),
          whole:
            name.scrollWidth <= name.clientWidth + 0.5 &&
            name.scrollHeight <= name.clientHeight + 0.5,
          // Beside the name or on a line under it, never over it.
          clear: others.every(
            (rect) =>
              rect.left >= box.right - 0.5 || rect.top >= box.bottom - 0.5,
          ),
        };
      },
    );
    const rect = popup?.getBoundingClientRect();
    // The composer's box the picker's button sits in.
    const box = document
      .querySelector(".rounded-2xl.border")
      ?.getBoundingClientRect();
    return {
      rows,
      // Within the message box's sides, as the app's other popups keep to what opened them.
      alongTheBox:
        rect && box
          ? rect.left >= box.left - 0.5 && rect.right <= box.right + 0.5
          : false,
      inside: rect
        ? rect.left >= -0.5 &&
          rect.right <= innerWidth + 0.5 &&
          rect.top >= -0.5 &&
          rect.bottom <= innerHeight + 0.5
        : false,
      // The page's 16px gutter between the popup and each side of the window.
      gutter: rect
        ? Math.round(Math.min(rect.left, innerWidth - rect.right)) >= 16
        : false,
      sideways: document.documentElement.scrollWidth > innerWidth,
    };
  });
}

describe.skipIf(!asked)("the composer's model picker", () => {
  /*
   * With a model that thinks, the popup is two columns (the models and the thinking levels); with
   * none, the models alone, a narrow column, which is where it hung past the message box.
   */
  for (const alone of [false, true])
    for (const engine of engines)
      for (const theme of THEMES)
        for (const window of WINDOWS)
          test(`names every model whole${alone ? ", the models alone," : ""} in ${engine}, ${theme}, ${window.width}px`, async () => {
            const browser = browsers.get(engine);
            if (!browser) throw new Error(`no ${engine}`);
            const page = await browser.newPage({
              viewport: window,
              colorScheme: theme,
              reducedMotion: "reduce",
            });
            page.on("pageerror", (error) => console.error(error));
            const inter = join(
              packageDir("@fontsource-variable/inter"),
              "files",
            );
            await page.route(`${ORIGIN}/**`, (route) => {
              const path = new URL(route.request().url()).pathname;
              if (path === "/screens.js")
                return route.fulfill({
                  contentType: "text/javascript",
                  body: script,
                });
              const font = join(inter, path.split("/").pop() ?? "");
              if (path.startsWith("/files/") && existsSync(font))
                return route.fulfill({ path: font });
              return route.fulfill({
                contentType: "text/html",
                body: `<!doctype html><html lang="en" class="${theme}" style="color-scheme: ${theme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head><body><div id="root"></div><script type="module" src="/screens.js"></script></body></html>`,
              });
            });
            try {
              await page.goto(`${ORIGIN}/${alone ? "?thinking=none" : ""}`);
              const trigger = page.getByRole("combobox", { name: /^Model:/ });
              await trigger.waitFor();
              await restyle(page);
              await page.evaluate(() => document.fonts.ready);
              await trigger.click();
              await page
                .getByRole("option", { name: /GPT-4\.1 Mini/ })
                .waitFor();
              // Off the trigger, so its tooltip isn't drawn over the popup's corner.
              await page.mouse.move(0, 0);
              await restyle(page);
              if (shots) {
                mkdirSync(shots, { recursive: true });
                await page.screenshot({
                  path: join(
                    shots,
                    `model-picker${alone ? "-alone" : ""}-${engine}-${theme}-${window.width}.png`,
                  ),
                });
              }
              const drawn = await measured(page);
              expect(drawn.rows.map((row) => row.name)).toEqual([
                "GPT-6.1 Terra",
                "GPT-4.1 Mini",
                "GPT-4.1",
                "Claude Sonnet 4.5 (September 2025)",
              ]);
              expect(drawn.rows.filter((row) => !row.whole)).toEqual([]);
              // A short name keeps one line; the Default tag goes under it where both don't fit.
              expect(drawn.rows.slice(0, 3).map((row) => row.lines)).toEqual([
                1, 1, 1,
              ]);
              expect(drawn.rows.filter((row) => !row.clear)).toEqual([]);
              expect(drawn.inside).toBe(true);
              // Never nearer a side of the window than the page's own gutter: at 5px it was.
              expect(drawn.gutter).toBe(true);
              // Never hanging past the message box: started from the button's left, it did by 150px.
              expect(drawn.alongTheBox).toBe(true);
              expect(drawn.sideways).toBe(false);
            } finally {
              await page.close();
            }
          }, 60_000);
});
