import { afterAll, beforeAll, describe, expect } from "bun:test";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Browser, BrowserType, Page } from "playwright-core";
import { compile } from "tailwindcss";
import { test } from "./renderer-crash";

/**
 * Browse apps shows the first page of the directory at once, and the next as the person scrolls.
 *
 * Reported on OpenBot 1.2.1: Browse apps sat on its placeholder rows for a long time when nothing
 * was typed, while a search came back quickly. The screen read every page of the directory before
 * it drew any: on the hosted service that was 18 requests one after another, about half a second
 * each, and 1,792 rows drawn at once, about fifteen seconds before the first row appeared.
 *
 * The real screen in a real browser, against a directory the size of the live one whose pages each
 * take as long to answer as they did there (browse-apps-pages.fixture.tsx):
 *
 * - With nothing typed, the first page is drawn after one request, well before every page could
 *   have been read, and the count still says how many apps there are in all.
 * - Scrolling to the end reads the next page, and the rows already drawn stay where they were.
 * - A search is read a page at a time too, and says how many apps match in all.
 *
 *   OPENBOT_APP_BROWSER=1 bun test app/tests/browse-apps-pages.test.tsx
 *
 * Chromium by default, as CI has it. OPENBOT_APP_ENGINES=chromium,webkit adds WebKit. With
 * OPENBOT_APP_SHOTS=<dir> each step is saved as browse-apps-<step>-<engine>-<theme>-<width>.png.
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

/** How long each page of the directory takes to answer, as a page did on the hosted service. */
const LATENCY_MS = 300;
/** The fixture's directory: 1,800 apps, 18 pages of 100 as the screen used to read them. */
const APPS = 1_800;
/**
 * The first rows are on screen inside this. Reading every page first takes at least eighteen times
 * the latency (5.4 seconds) before a row can be drawn.
 */
const FIRST_PAGE_MS = 3_000;

/** A phone, and a wide desktop window. */
const WIDTHS = [390, 1440] as const;

/** The fixture bundled for the browser. `@/lib/marks` is Vite's `import.meta.glob`, so no marks. */
async function bundle(): Promise<string> {
  const built = await Bun.build({
    entrypoints: [join(import.meta.dir, "browse-apps-pages.fixture.tsx")],
    target: "browser",
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

async function open(
  engine: string,
  theme: "light" | "dark",
  width: number,
): Promise<Page> {
  const browser = browsers.get(engine);
  if (!browser) throw new Error(`no ${engine}`);
  const page = await browser.newPage({
    viewport: { width, height: 900 },
    colorScheme: theme,
    reducedMotion: "reduce",
  });
  page.on("pageerror", (error) => console.error(error));
  const inter = join(packageDir("@fontsource-variable/inter"), "files");
  await page.route(`${ORIGIN}/**`, (route) => {
    const at = new URL(route.request().url()).pathname;
    if (at === "/browse.js")
      return route.fulfill({ contentType: "text/javascript", body: script });
    const font = join(inter, at.split("/").pop() ?? "");
    if (at.startsWith("/files/") && existsSync(font))
      return route.fulfill({ path: font });
    // The fixture answers the API itself; anything that reaches the network has nowhere to go.
    if (at.startsWith("/api/")) return route.fulfill({ status: 404 });
    return route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html lang="en" class="${theme}" style="color-scheme: ${theme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head><body><div id="root"></div><script type="module" src="/browse.js"></script></body></html>`,
    });
  });
  await page.goto(
    `${ORIGIN}/connections/browse/composio?theme=${theme}&latency=${LATENCY_MS}`,
  );
  return page;
}

async function shoot(page: Page, step: string, name: string) {
  if (!shots) return;
  // Styled for everything now on the page, as the app's build styles it.
  const classes = await page.evaluate(() =>
    [...document.querySelectorAll("[class]")].flatMap((element) => [
      ...element.classList,
    ]),
  );
  await page.addStyleTag({ content: await stylesheet([...new Set(classes)]) });
  await page.evaluate(() => document.fonts.ready);
  // Rows and buttons fade their borders in as the stylesheet lands; shot once they have. WebKit
  // rejects a transition that another replaced, which is settled all the same.
  await page.evaluate(() =>
    Promise.allSettled(
      document.getAnimations().map((animation) => animation.finished),
    ),
  );
  mkdirSync(shots, { recursive: true });
  await page.screenshot({
    path: join(shots, `browse-apps-${step}-${name}.png`),
  });
}

/** The directory's rows on screen, by their test ids, in order. */
const rows = (page: Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll("[data-testid^=directory-app]")].map((row) =>
      row.getAttribute("data-testid"),
    ),
  );

/** The reads of the directory the screen has sent, as their query strings. */
const reads = (page: Page) =>
  page.evaluate(
    () =>
      (window as unknown as { __directoryReads: string[] }).__directoryReads,
  );

/** Nothing runs off the side of the page. */
const sideways = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth > innerWidth);

describe.skipIf(!asked)("Browse apps, a page at a time", () => {
  for (const engine of engines)
    for (const theme of ["light", "dark"] as const)
      for (const width of WIDTHS) {
        const name = `${engine}-${theme}-${width}`;

        test(`the first page shows at once and the next loads on scrolling, in ${name}`, async () => {
          const started = Date.now();
          const page = await open(engine, theme, width);
          try {
            // The placeholders, while the first page is on its way (unstyled here, so of no size).
            await page
              .getByRole("status", { name: "Loading apps" })
              .waitFor({ state: "attached", timeout: 15_000 });

            const first = page.getByTestId("directory-app0000");
            await first.waitFor({ timeout: 15_000 });
            const shownAfter = Date.now() - started;
            // One request, one page, and the count of the whole directory.
            expect(await reads(page)).toEqual(["?source=directory&limit=50"]);
            expect(shownAfter).toBeLessThan(FIRST_PAGE_MS);
            expect((await rows(page)).length).toBe(50);
            await page
              .getByText(
                `${APPS.toLocaleString("en-US")} apps. Search by name to narrow them.`,
              )
              .waitFor();
            expect(await sideways(page)).toBe(false);
            await shoot(page, "first-page", name);

            // Apps you sign in to first: App 0009 takes a key, so it is not on the first page.
            const firstPage = await rows(page);
            expect(firstPage[0]).toBe("directory-app0000");
            expect(firstPage).not.toContain("directory-app0009");

            // To the end of the list: the next page is read, and comes after what was there.
            await page
              .getByTestId("directory-more")
              .scrollIntoViewIfNeeded({ timeout: 15_000 });
            await page.waitForFunction(
              () =>
                document.querySelectorAll("[data-testid^=directory-app]")
                  .length >= 100,
              undefined,
              { timeout: 15_000 },
            );
            const read = await reads(page);
            expect(read.length).toBeGreaterThanOrEqual(2);
            expect(read[1]).toMatch(/^\?source=directory&limit=50&cursor=/);
            const twoPages = await rows(page);
            expect(twoPages.slice(0, 50)).toEqual(firstPage);
            expect(new Set(twoPages).size).toBe(twoPages.length);
            expect(await sideways(page)).toBe(false);
            await shoot(page, "next-page", name);
          } finally {
            await page.close();
          }
        }, 120_000);

        test(`a search is read a page at a time and says how many match, in ${name}`, async () => {
          const page = await open(engine, theme, width);
          try {
            await page
              .getByTestId("directory-app0000")
              .waitFor({ timeout: 15_000 });
            await page
              .getByRole("textbox", { name: "Search apps" })
              .fill("app 1");
            await page
              .getByTestId("directory-app1000")
              .waitFor({ timeout: 15_000 });
            // App 1000 to App 1799, less the eighty that take a key, on the first page; all 800 counted.
            await page.getByText("800 matches").waitFor();
            const searched = (await reads(page)).filter((query) =>
              query.includes("search="),
            );
            expect(searched).toEqual([
              "?source=directory&limit=50&search=app+1",
            ]);
            expect((await rows(page)).length).toBe(50);
            expect(await sideways(page)).toBe(false);
            await shoot(page, "search", name);
          } finally {
            await page.close();
          }
        }, 120_000);
      }
});
