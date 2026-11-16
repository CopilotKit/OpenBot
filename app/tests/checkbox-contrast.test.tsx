import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Browser, Page } from "playwright-core";
import { compile } from "tailwindcss";

/**
 * An unticked tickbox can be seen, in light and in dark.
 *
 * Seen on a Bot's Agents page in dark: the agents it may hand work to and doesn't yet were drawn
 * with a tickbox whose edge was the colour of the row under it, so the list read as names with
 * nothing to tick. The tickbox's edge was the `--input` token, which is the faint line of a field,
 * about 1.3:1 against the surfaces the app puts a tickbox on, in light as well as dark. WCAG 2.2's
 * 1.4.11 (Non-text Contrast) asks for 3:1 between what identifies a control and the colours next to
 * it, and an unticked tickbox is identified by its edge alone.
 *
 * Measured on what the browser paints, not on the tokens: the app's own Agents section
 * (`BotDelegation`) and the tickbox on the page, a card, a menu or dialog, and a `bg-muted/50` row,
 * all from checkbox-contrast.fixture.tsx, styled by the app's stylesheet. Each unticked tickbox is
 * screenshotted with a few pixels of what is round it, and the edge's colour is held against the
 * colour beside it, by WCAG's relative luminance and contrast ratio.
 *
 *   OPENBOT_APP_BROWSER=1 bun test app/tests/checkbox-contrast.test.tsx
 *
 * Chromium by default, as CI has it. OPENBOT_APP_ENGINES=chromium,webkit adds WebKit. With
 * OPENBOT_APP_SHOTS=<dir> each page is saved as checkbox-contrast-<engine>-<theme>.png.
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
/** WCAG 2.2, 1.4.11 Non-text Contrast: user interface components, against adjacent colours. */
const NON_TEXT_CONTRAST = 3;
/** CSS pixels of the surface round each tickbox that are screenshotted with it. */
const MARGIN = 6;

async function bundle(): Promise<string> {
  const built = await Bun.build({
    entrypoints: [join(import.meta.dir, "checkbox-contrast.fixture.tsx")],
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

type Rgb = [number, number, number];

/** WCAG 2.2's relative luminance of an sRGB colour, channels 0 to 255. */
function luminance([r, g, b]: Rgb): number {
  const [R, G, B] = [r, g, b].map((channel) => {
    const c = channel / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as Rgb;
  return 0.2126 * R + 0.7152 * G + 0.0722 * B;
}

/** WCAG 2.2's contrast ratio, from 1 to 21. */
function contrast(a: Rgb, b: Rgb): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [
    number,
    number,
  ];
  return (light + 0.05) / (dark + 0.05);
}

/**
 * The page's script, built before any test starts. This waits for the bundle, not on a hook's
 * clock: a `beforeAll` gets 5 s, and on a cold runner bundling can take longer. Each test starts
 * its own browser, inside the test's own time.
 */
let script: string;
if (asked) script = await bundle();
const browsers: Browser[] = [];

afterAll(async () => {
  await Promise.all(browsers.map((browser) => browser.close()));
});

async function open(
  name: "chromium" | "webkit",
  theme: (typeof THEMES)[number],
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
    viewport: { width: 900, height: 1200 },
    deviceScaleFactor: 2,
  });
  page.on("pageerror", (error) => console.error(error));
  await page.route(`${ORIGIN}/**`, (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/app.js")
      return route.fulfill({ contentType: "text/javascript", body: script });
    if (url.pathname.startsWith("/api/"))
      return route.fulfill({ status: 404, json: { error: "not here" } });
    if (url.pathname.includes("."))
      return route.fulfill({ status: 404, body: "" });
    return route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html lang="en" class="${theme}"><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module" src="/app.js"></script></body></html>`,
    });
  });
  await page.goto(`${ORIGIN}/`, { waitUntil: "domcontentloaded" });
  await page.getByText("Agents it may use").first().waitFor();
  const classes = await page.evaluate(() =>
    [...document.querySelectorAll("[class]")].flatMap((element) => [
      ...element.classList,
    ]),
  );
  await page.addStyleTag({ content: await stylesheet([...new Set(classes)]) });
  // The tickbox eases its border colour in; let it land.
  await page.waitForTimeout(400);
  return page;
}

/** The middle row of pixels through one screenshot, decoded by the browser itself. */
async function middleRow(page: Page, png: Buffer): Promise<Rgb[]> {
  return page.evaluate(async (base64) => {
    const image = new Image();
    image.src = `data:image/png;base64,${base64}`;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("no 2d context");
    context.drawImage(image, 0, 0);
    const y = Math.floor(image.naturalHeight / 2);
    const data = context.getImageData(0, y, image.naturalWidth, 1).data;
    const row: [number, number, number][] = [];
    for (let x = 0; x < image.naturalWidth; x++)
      row.push([data[x * 4], data[x * 4 + 1], data[x * 4 + 2]] as [
        number,
        number,
        number,
      ]);
    return row;
  }, png.toString("base64"));
}

/** Each enabled, unticked tickbox: what it is, and its edge's contrast with the surface beside it. */
async function measure(page: Page) {
  const boxes = page.locator(
    "[data-slot=checkbox]:not([data-checked]):not([data-disabled])",
  );
  const count = await boxes.count();
  const found: { what: string; edge: string; beside: string; ratio: number }[] =
    [];
  for (let index = 0; index < count; index++) {
    const box = boxes.nth(index);
    const what = await box.evaluate(
      (element) =>
        element.getAttribute("data-surface") ??
        element.closest("li")?.querySelector(".font-medium")?.textContent ??
        element.id,
    );
    const rect = await box.boundingBox();
    if (!rect) throw new Error(`no box for ${what}`);
    const png = await page.screenshot({
      clip: {
        x: rect.x - MARGIN,
        y: rect.y,
        width: rect.width + 2 * MARGIN,
        height: rect.height,
      },
    });
    const row = await middleRow(page, png);
    const scale = row.length / (rect.width + 2 * MARGIN);
    const edgeAt = Math.round(MARGIN * scale);
    // The surface: a little way out from the tickbox, on each side.
    const left = row[Math.round(2 * scale)] as Rgb;
    const right = row[row.length - 1 - Math.round(2 * scale)] as Rgb;
    // The edge: the pixel near each side that stands out most from the surface beside it.
    const strongest = (from: number, to: number, beside: Rgb) => {
      let best: Rgb = beside;
      for (let x = Math.max(0, from); x <= Math.min(row.length - 1, to); x++) {
        const pixel = row[x] as Rgb;
        if (contrast(pixel, beside) > contrast(best, beside)) best = pixel;
      }
      return best;
    };
    const leftEdge = strongest(edgeAt - 2, edgeAt + 3, left);
    const rightEdge = strongest(
      row.length - 1 - edgeAt - 3,
      row.length - 1 - edgeAt + 2,
      right,
    );
    const sides = [
      { edge: leftEdge, beside: left, ratio: contrast(leftEdge, left) },
      { edge: rightEdge, beside: right, ratio: contrast(rightEdge, right) },
    ].sort((a, b) => a.ratio - b.ratio);
    const weaker = sides[0] as (typeof sides)[number];
    found.push({
      what: (what ?? "").trim(),
      edge: `rgb(${weaker.edge.join(", ")})`,
      beside: `rgb(${weaker.beside.join(", ")})`,
      ratio: Math.round(weaker.ratio * 100) / 100,
    });
  }
  return found;
}

describe.skipIf(!asked)("an unticked tickbox", () => {
  for (const name of engines) {
    for (const theme of THEMES) {
      test(`in ${name}, ${theme}: its edge stands 3:1 from what it is drawn on`, async () => {
        const page = await open(name, theme);
        if (shots) {
          mkdirSync(shots, { recursive: true });
          await page.screenshot({
            path: join(shots, `checkbox-contrast-${name}-${theme}.png`),
            fullPage: true,
          });
        }
        const found = await measure(page);
        console.log(`${name} ${theme}`);
        for (const each of found)
          console.log(
            `  ${each.ratio.toFixed(2)}:1  ${each.what}  edge ${each.edge} beside ${each.beside}`,
          );
        // The Agents page's two agents not yet chosen, and the four surfaces.
        expect(found.length).toBe(6);
        expect(found.filter((each) => each.ratio < NON_TEXT_CONTRAST)).toEqual(
          [],
        );
      }, 120_000);
    }
  }
});
