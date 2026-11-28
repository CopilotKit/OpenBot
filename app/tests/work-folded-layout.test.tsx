import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Browser, BrowserType, Page } from "playwright-core";
import { compile } from "tailwindcss";

/**
 * A Bot's work, folded in a real conversation in a real browser, and nothing else.
 *
 * Reported from OpenBot Cloud: asked for the day's top five articles on a news site, a Bot ran one
 * command, and the conversation drew it in a terminal card with every line it printed, so the answer
 * sat below a screen of raw output. Here the transcript the app draws holds a browsing run, that
 * command, a Gmail run, a file the Bot sent, its answer and an approval it is waiting for. The work
 * is three folded lines; the file, the answer and the approval are in view, whole, as before. A
 * folded line opens to its card. A command still running shimmers on its line. In the app's
 * stylesheet, light and dark, at a laptop's width and a phone's: nothing scrolls sideways.
 *
 *   OPENBOT_APP_BROWSER=1 bun test app/tests/work-folded-layout.test.tsx
 *
 * Chromium by default, as CI has it. OPENBOT_APP_ENGINES=chromium,webkit adds WebKit. With
 * OPENBOT_APP_SHOTS=<dir> each state is saved as work-<state>-<engine>-<theme>-<width>.png.
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

async function bundle(): Promise<string> {
  const built = await Bun.build({
    entrypoints: [join(import.meta.dir, "work-folded-layout.fixture.tsx")],
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
  state: "done" | "running",
): Promise<Page> {
  const browser = browsers.get(engine);
  if (!browser) throw new Error(`no ${engine}`);
  const page = await browser.newPage({
    viewport: window,
    colorScheme: theme,
    // The finished conversation holds still for its picture; the running one shows its shimmer.
    reducedMotion: state === "running" ? "no-preference" : "reduce",
  });
  page.on("pageerror", (error) => console.error(error));
  const inter = join(packageDir("@fontsource-variable/inter"), "files");
  await page.route(`${ORIGIN}/**`, (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/work.js")
      return route.fulfill({ contentType: "text/javascript", body: script });
    const font = join(inter, path.split("/").pop() ?? "");
    if (path.startsWith("/files/") && existsSync(font))
      return route.fulfill({ path: font });
    if (path.startsWith("/api/")) return route.fulfill({ status: 404 });
    return route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html lang="en" class="${theme}" style="color-scheme: ${theme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head><body><div id="root"></div><script type="module" src="/work.js"></script></body></html>`,
    });
  });
  await page.goto(`${ORIGIN}/?state=${state}`);
  await page
    .getByRole("region", { name: "Conversation" })
    .waitFor({ timeout: 15_000 });
  // The command's card is drawn, folded or not.
  await page
    .locator('section[aria-label="Ran a command"]')
    .waitFor({ state: "attached", timeout: 15_000 });
  if (state === "done")
    await page
      .getByRole("region", { name: "Waiting for your approval" })
      .waitFor({ timeout: 15_000 });
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

async function shoot(page: Page, name: string) {
  if (!shots) return;
  mkdirSync(shots, { recursive: true });
  await page.screenshot({ path: join(shots, `${name}.png`), fullPage: true });
}

/** Whether what holds this element is a fold, and whether that fold is open. */
function foldOf(page: Page, selector: string) {
  return page.$$eval(selector, (elements) =>
    elements.map((element) => {
      const fold = element.closest("details");
      return fold ? (fold.open ? "open" : "folded") : "in view";
    }),
  );
}

const WINDOWS: Window[] = [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
];

describe.skipIf(!asked)("a Bot's work in a conversation", () => {
  for (const engine of engines)
    for (const theme of ["light", "dark"] as const)
      for (const window of WINDOWS) {
        const name = `${engine}-${theme}-${window.width}`;

        test(`is folded and everything for the person is in view, in ${engine}, ${theme}, ${window.width}px`, async () => {
          const page = await open(engine, theme, window, "done");
          try {
            await shoot(page, `work-done-${name}`);
            expect(
              await page.evaluate(
                () => document.documentElement.scrollWidth > innerWidth,
              ),
            ).toBe(false);

            // The work: three lines, each folded, none of its detail on screen.
            expect(
              await foldOf(page, 'section[aria-label="Ran a command"]'),
            ).toEqual(["folded"]);
            for (const line of [
              "Ran a command",
              "Browsed dev.to",
              "Used Gmail",
            ]) {
              const summary = page.locator("summary", { hasText: line });
              expect(await summary.isVisible()).toBe(true);
              const box = await summary.boundingBox();
              // One line: the label and what it was done to, never wrapped.
              expect(box?.height ?? 99).toBeLessThanOrEqual(28);
            }
            expect(
              await page
                .getByRole("region", { name: "Ran a command" })
                .isVisible(),
            ).toBe(false);
            expect(
              await page.getByText("debug: fetched page 20").isVisible(),
            ).toBe(false);

            // For the person: the answer, the file and the approval, whole and not behind a fold.
            expect(
              await page
                .getByText("The Price You Pay for Passion")
                .first()
                .isVisible(),
            ).toBe(true);
            expect(
              await foldOf(
                page,
                '[aria-label="File from the Bot: top-articles.csv"]',
              ),
            ).toEqual(["in view"]);
            expect(
              await page
                .getByRole("figure", {
                  name: "File from the Bot: top-articles.csv",
                })
                .isVisible(),
            ).toBe(true);
            expect(
              await foldOf(page, '[aria-label="Waiting for your approval"]'),
            ).toEqual(["in view"]);
            expect(
              await page
                .getByRole("region", { name: "Waiting for your approval" })
                .isVisible(),
            ).toBe(true);

            // Opened, the command is its terminal block as it always was, inside the column.
            await page.locator("summary", { hasText: "Ran a command" }).click();
            const block = page.getByRole("region", { name: "Ran a command" });
            expect(await block.isVisible()).toBe(true);
            expect(await block.textContent()).toContain("Exit 0");
            const box = await block.boundingBox();
            expect((box?.x ?? -1) >= 0).toBe(true);
            expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(
              window.width + 0.5,
            );
            await shoot(page, `work-opened-${name}`);
          } finally {
            await page.close();
          }
        }, 90_000);

        test(`shimmers on a command's line while it runs, in ${engine}, ${theme}, ${window.width}px`, async () => {
          const page = await open(engine, theme, window, "running");
          try {
            // The rows' entrances over, and the band caught part-way across, for the picture.
            await page.evaluate(() =>
              Promise.all(
                document
                  .getAnimations()
                  .filter(
                    (animation) =>
                      animation.effect?.getComputedTiming().iterations !==
                        Number.POSITIVE_INFINITY &&
                      animation.timeline === document.timeline,
                  )
                  .map((animation) => animation.finished),
              ),
            );
            await page.evaluate(() => {
              for (const line of document.querySelectorAll(
                ".tool-line-running",
              ))
                for (const animation of line.getAnimations()) {
                  animation.pause();
                  animation.currentTime = 1000;
                }
            });
            await shoot(page, `work-running-${name}`);
            const line = page.locator("summary .tool-line-running", {
              hasText: "Running a command",
            });
            expect(await line.isVisible()).toBe(true);
            expect(
              await line.evaluate(
                (element) => getComputedStyle(element).animationName,
              ),
            ).toBe("tool-line-shimmer");
            expect(
              await foldOf(page, 'section[aria-label="Ran a command"]'),
            ).toEqual(["folded"]);
          } finally {
            await page.close();
          }
        }, 90_000);
      }
});
