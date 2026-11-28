import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Browser, BrowserType, Page } from "playwright-core";
import { compile } from "tailwindcss";

/**
 * A Bot's command, as the conversation and the Activity pane draw it, in a real browser.
 *
 * The conversation's card says what ran, what it printed and how it exited, in one card that fits
 * the chat's column. Activity says the same of that command, and of one the gate refused it says
 * "Didn't run", never "Exit 0": on OpenBot Cloud a refused command read "Ran … Exit 0" there beside a
 * card saying "Didn't run", and was taken for a command whose output the Bot had lost. In the app's
 * stylesheet, light and dark, at a laptop's width and a phone's: nothing scrolls sideways and every
 * card is whole inside the window.
 *
 *   OPENBOT_APP_BROWSER=1 bun test app/tests/command-card-layout.test.tsx
 *
 * Chromium by default, as CI has it. OPENBOT_APP_ENGINES=chromium,webkit adds WebKit. With
 * OPENBOT_APP_SHOTS=<dir> each is saved as command-card-<engine>-<theme>-<width>.png.
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
    entrypoints: [join(import.meta.dir, "command-card-layout.fixture.tsx")],
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

async function open(
  engine: string,
  theme: "light" | "dark",
  window: { width: number; height: number },
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
    if (path === "/command.js")
      return route.fulfill({ contentType: "text/javascript", body: script });
    const font = join(inter, path.split("/").pop() ?? "");
    if (path.startsWith("/files/") && existsSync(font))
      return route.fulfill({ path: font });
    if (path.startsWith("/api/")) return route.fulfill({ status: 404 });
    return route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html lang="en" class="${theme}" style="color-scheme: ${theme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head><body><div id="root"></div><script type="module" src="/command.js"></script></body></html>`,
    });
  });
  await page.goto(`${ORIGIN}/`);
  await page
    .getByRole("region", { name: "Conversation" })
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

/** What each card says, and whether it is whole inside the window. */
function cards(page: Page) {
  return page.evaluate(() => {
    const read = (part: string) =>
      [
        ...document.querySelectorAll(
          `[data-part="${part}"] section[aria-label]`,
        ),
      ].map((card) => {
        const box = card.getBoundingClientRect();
        return {
          text: (card.textContent ?? "").replace(/\s+/g, " ").trim(),
          inside: box.left >= 0 && box.right <= innerWidth + 0.5,
          // Its header on one row: the label, the time and the status, never stacked.
          header:
            (card.querySelector("header")?.getBoundingClientRect().height ??
              0) <= 32,
        };
      });
    return {
      conversation: read("conversation"),
      activity: read("activity"),
      sideways: document.documentElement.scrollWidth > innerWidth,
    };
  });
}

describe.skipIf(!asked)("a Bot's command card", () => {
  for (const engine of engines)
    for (const theme of ["light", "dark"] as const)
      for (const window of [
        { width: 1440, height: 900 },
        { width: 390, height: 844 },
      ])
        test(`says what ran and what it printed, and Activity agrees, in ${engine}, ${theme}, ${window.width}px`, async () => {
          const page = await open(engine, theme, window);
          try {
            if (shots) {
              mkdirSync(shots, { recursive: true });
              await page.screenshot({
                path: join(
                  shots,
                  `command-card-${engine}-${theme}-${window.width}.png`,
                ),
                fullPage: true,
              });
            }
            const drawn = await cards(page);
            expect(drawn.sideways).toBe(false);
            const [chat] = drawn.conversation;
            expect(chat?.text).toContain("Ran a command");
            expect(chat?.text).toContain("Exit 0");
            expect(chat?.text).toContain("2191 total");
            expect(chat?.inside).toBe(true);
            expect(chat?.header).toBe(true);
            expect(drawn.activity).toHaveLength(2);
            const refused = drawn.activity.find((card) =>
              card.text.includes("cat ~/reports/notes.md"),
            );
            const ran = drawn.activity.find((card) =>
              card.text.includes("wc -l"),
            );
            expect(refused?.text).toContain("Didn't run");
            expect(refused?.text).not.toContain("Exit 0");
            expect(refused?.text).toContain(
              "That unanswered tool call is not saved in this conversation.",
            );
            expect(ran?.text).toContain("Exit 0");
            expect(ran?.text).toContain("2191 total");
            for (const card of drawn.activity) {
              expect(card.inside).toBe(true);
              expect(card.header).toBe(true);
            }
          } finally {
            await page.close();
          }
        }, 90_000);
});
