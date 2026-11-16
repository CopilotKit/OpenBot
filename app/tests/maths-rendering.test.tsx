import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Browser, Page } from "playwright-core";
import { compile } from "tailwindcss";

/**
 * Maths a Bot writes is drawn as formulas, everywhere its words are drawn: a reply, a task's thread,
 * the task's result line in the conversation that asked for it, and a card's text.
 *
 * Seen on 2026-11-16: asked for a loan payment, a Bot answered "calculated using
 * (P r / [1-(1+r)^{-n}])" and a compound-interest formula as "[ A=P\left(1+\frac{r}{n}\right)^{nt} ]".
 * The chat drew LaTeX as source, and markdown had eaten the backslashes of `\(` and `\[`.
 *
 * The page is the real transcript and card text, bundled from maths-rendering.fixture.tsx with the
 * app's stylesheet and KaTeX's, in a real browser. Each surface is checked for: every formula drawn
 * by KaTeX in KaTeX's own font, the one set apart as a block; no delimiter left on screen; prices and
 * the code block drawn as written; and on a phone, the wide formula scrolling sideways inside its
 * own block while the page does not.
 *
 *   OPENBOT_APP_BROWSER=1 bun test app/tests/maths-rendering.test.tsx
 *
 * Chromium by default, as CI has it. OPENBOT_APP_ENGINES=chromium,webkit adds WebKit. With
 * OPENBOT_APP_SHOTS=<dir> each page is saved as maths-<engine>-<theme>-<width>-<surface>.png.
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
const SURFACES = ["direct", "thread", "origin", "card"] as const;
const THEMES = ["light", "dark"] as const;
const WIDTHS = [1440, 390] as const;

/** The formulas the answer holds, as KaTeX keeps their source beside what it draws. */
const FORMULAS = [
  "M = P\\frac{r}{1-(1+r)^{-n}}",
  "P=\\$25{,}000",
  "n=60",
  "r = \\frac{0.065}{12}",
];
const SET_APART = "\\approx 489.15";

/** The fixture and what it imports, KaTeX's stylesheet and fonts among them, built for a browser. */
async function bundle(): Promise<Map<string, { type: string; body: Blob }>> {
  const built = await Bun.build({
    entrypoints: [join(import.meta.dir, "maths-rendering.fixture.tsx")],
    target: "browser",
    naming: { entry: "fixture.[ext]", asset: "[name].[ext]" },
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
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
  });
  if (!built.success) throw new AggregateError(built.logs, "bundle failed");
  const files = new Map<string, { type: string; body: Blob }>();
  for (const output of built.outputs)
    files.set(`/${basename(output.path)}`, {
      type: output.type,
      body: output,
    });
  return files;
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

let files: Map<string, { type: string; body: Blob }>;
const browsers = new Map<string, Browser>();
/** The app's stylesheet for every class the four surfaces draw, built once. */
let css = "";

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
  if (!asked) return;
  files = await bundle();
  const classes = new Set<string>();
  for (const surface of SURFACES) {
    const page = await open("chromium", "light", 1440, surface, false);
    try {
      for (const name of await page.evaluate(() =>
        [...document.querySelectorAll("[class]")].flatMap((element) => [
          ...element.classList,
        ]),
      ))
        classes.add(name);
    } finally {
      await page.close();
    }
  }
  css = await stylesheet([...classes]);
}, 120_000);

afterAll(async () => {
  await Promise.all([...browsers.values()].map((browser) => browser.close()));
});

async function open(
  engine: "chromium" | "webkit",
  theme: (typeof THEMES)[number],
  width: number,
  surface: (typeof SURFACES)[number],
  styled = true,
): Promise<Page> {
  const browser = await browserFor(engine);
  const page = await browser.newPage({
    viewport: { width, height: 900 },
    deviceScaleFactor: 2,
  });
  page.on("pageerror", (error) => console.error(error));
  await page.route(`${ORIGIN}/**`, (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/")
      return route.fulfill({
        contentType: "text/html",
        body: `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${styled ? css : ""}</style><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>`,
      });
    const file = files.get(path);
    if (file)
      return file.body
        .arrayBuffer()
        .then((body) =>
          route.fulfill({ contentType: file.type, body: Buffer.from(body) }),
        );
    return route.fulfill({ status: 404, body: "" });
  });
  await page.goto(`${ORIGIN}/?surface=${surface}&theme=${theme}`);
  // The reply is revealed at a reading pace; its last paragraph is the code block.
  await page
    .getByText('pattern = r"\\(\\d+\\)"', { exact: false })
    .first()
    .waitFor({ timeout: 20_000 });
  return page;
}

/** What the surface shows, read from the page. */
function read(page: Page) {
  return page.evaluate(async (setApart) => {
    await document.fonts.ready;
    const surface = document.querySelector("[data-surface]");
    if (!surface) throw new Error("no surface drawn");
    const formulas = [...surface.querySelectorAll(".katex")];
    const source = (element: Element) =>
      element.querySelector('annotation[encoding="application/x-tex"]')
        ?.textContent ?? "";
    const display = [...surface.querySelectorAll(".katex-display")];
    const wide = display.find((block) => source(block).includes(setApart));
    // The words a reader sees outside the formulas and the code block.
    const prose = surface.cloneNode(true) as Element;
    for (const element of prose.querySelectorAll(
      ".katex, pre, code, [data-streamdown='code-block']",
    ))
      element.remove();
    const code = [...surface.querySelectorAll("pre, code")]
      .map((element) => element.textContent ?? "")
      .join("\n");
    return {
      sources: formulas.map(source),
      displaySources: display.map(source),
      inCode: surface.querySelectorAll("pre .katex, code .katex").length,
      prose: (prose.textContent ?? "").replace(/\s+/g, " "),
      code,
      katexFont: [...document.fonts].some(
        (font) =>
          font.family.includes("KaTeX_Main") && font.status === "loaded",
      ),
      formulaFont: formulas[0]
        ? getComputedStyle(
            formulas[0].querySelector(".katex-html .mord") ?? formulas[0],
          ).fontFamily
        : "",
      wide: wide
        ? { scroll: wide.scrollWidth, client: wide.clientWidth }
        : null,
      pageScroll: document.documentElement.scrollWidth,
      viewport: window.innerWidth,
    };
  }, SET_APART);
}

describe.skipIf(!asked)("maths a Bot writes", () => {
  for (const engine of engines) {
    for (const theme of THEMES) {
      for (const width of WIDTHS) {
        for (const surface of SURFACES) {
          test(`${engine}, ${theme}, ${width}px, ${surface}: formulas drawn, prices and code as written`, async () => {
            const page = await open(engine, theme, width, surface);
            try {
              // The first formula fetches the maths plugin; the checks below say if none came.
              await page
                .waitForSelector(".katex-display", { timeout: 10_000 })
                .catch(() => {});
              // The reply fades in as it arrives; read and shoot it once it has landed. Only the
              // animations that end are waited for: a running step's pulse never does.
              await page.evaluate(() =>
                Promise.race([
                  Promise.all(
                    document
                      .getAnimations()
                      .filter(
                        (animation) =>
                          animation.effect?.getComputedTiming().endTime !==
                          Number.POSITIVE_INFINITY,
                      )
                      .map((animation) => animation.finished.catch(() => {})),
                  ),
                  new Promise((done) => setTimeout(done, 3000)),
                ]),
              );
              const seen = await read(page);
              if (shots) {
                mkdirSync(shots, { recursive: true });
                await page.screenshot({
                  path: join(
                    shots,
                    `maths-${engine}-${theme}-${width}-${surface}.png`,
                  ),
                  fullPage: true,
                });
              }
              // Every formula, by KaTeX, in KaTeX's font.
              for (const formula of FORMULAS)
                expect(seen.sources).toContain(formula);
              expect(seen.displaySources).toHaveLength(1);
              expect(seen.displaySources[0]).toContain(SET_APART);
              expect(seen.katexFont).toBe(true);
              expect(seen.formulaFont).toContain("KaTeX");
              // No delimiter left on screen, and the prices are prices.
              expect(seen.prose).not.toContain("\\(");
              expect(seen.prose).not.toContain("\\[");
              expect(seen.prose).not.toContain("$$");
              expect(seen.prose).not.toContain("frac");
              expect(seen.prose).toContain(
                "The loan is $25,000 and fees run $5 to $10.",
              );
              expect(seen.prose).toContain("$489.15");
              // The code block, character for character, with no formula in it.
              expect(seen.inCode).toBe(0);
              expect(seen.code).toContain('price = "$25,000"');
              expect(seen.code).toContain('pattern = r"\\(\\d+\\)"');
              // A wide formula scrolls in its own block; the page never scrolls sideways.
              expect(seen.wide).not.toBeNull();
              if (width === 390 && seen.wide)
                expect(seen.wide.scroll).toBeGreaterThan(seen.wide.client);
              expect(seen.pageScroll).toBeLessThanOrEqual(seen.viewport);
            } finally {
              await page.close();
            }
          }, 60_000);
        }
      }
    }
  }
});
