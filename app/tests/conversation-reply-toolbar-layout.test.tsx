import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Browser, BrowserType, Page } from "playwright-core";
import { compile } from "tailwindcss";
import { marksPlugin } from "./marks-plugin";

/**
 * A conversation's finished reply carries the Bot chat page's own toolbar, drawn as it is there.
 *
 * Reported in dogfooding: replies in a conversation had no Copy, while the Bot chat page has
 * CopilotKit's toolbar under each one. The real transcript and the Bot chat page's message view are
 * drawn in a real browser, bundled from the fixture beside this file, with CopilotKit's stylesheet
 * and the app's, as the app loads them: the conversation's Copy sits under the reply, lined up with
 * its words, the same size and colour as the Bot chat page's, inside the window at a phone's width
 * as on a laptop. Light and dark, 390 and 1440.
 *
 *   OPENBOT_APP_BROWSER=1 bun test app/tests/conversation-reply-toolbar-layout.test.tsx
 *
 * Chromium by default, as CI has it. OPENBOT_APP_ENGINES=chromium,webkit adds WebKit. With
 * OPENBOT_APP_SHOTS=<dir> each is saved as reply-toolbar-<view>-<engine>-<theme>-<width>.png.
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

async function bundle(): Promise<string> {
  const built = await Bun.build({
    entrypoints: [
      join(import.meta.dir, "conversation-reply-toolbar-layout.fixture.tsx"),
    ],
    target: "browser",
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    plugins: [marksPlugin],
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
/** CopilotKit's stylesheet, loaded before the app's as `main.tsx` loads it. */
let copilotkit: string;

beforeAll(async () => {
  if (!asked) return;
  script = await bundle();
  copilotkit = readFileSync(
    packageStylesheet("@copilotkit/react-core/v2/styles.css"),
    "utf8",
  );
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
  theme: (typeof THEMES)[number],
  window: { width: number; height: number },
  view: "conversation" | "bot",
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
    if (path === "/screens.js")
      return route.fulfill({ contentType: "text/javascript", body: script });
    const font = join(inter, path.split("/").pop() ?? "");
    if (path.startsWith("/files/") && existsSync(font))
      return route.fulfill({ path: font });
    if (path.startsWith("/api/")) return route.fulfill({ status: 404 });
    return route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html lang="en" class="${theme}" style="color-scheme: ${theme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head><body><div id="root"></div><script type="module" src="/screens.js"></script></body></html>`,
    });
  });
  await page.goto(`${ORIGIN}/?view=${view}`);
  await page.getByTestId("copilot-copy-button").first().waitFor();
  await page.addStyleTag({ content: copilotkit });
  await style(page);
  await page.evaluate(() => document.fonts.ready);
  // Rows ease in: looked at once they are still.
  await page.waitForTimeout(400);
  return page;
}

/** Styles the classes the page draws now. */
async function style(page: Page) {
  const classes = await page.evaluate(() =>
    [...document.querySelectorAll("[class]")].flatMap((element) => [
      ...element.classList,
    ]),
  );
  await page.addStyleTag({ content: await stylesheet([...new Set(classes)]) });
}

/** Where the Copy button sits against the reply's words, and how it is drawn. */
function measured(page: Page) {
  return page.evaluate(() => {
    const copy = document.querySelector(
      "[data-testid=copilot-copy-button]",
    ) as HTMLElement;
    const icon = copy.querySelector("svg") as SVGElement;
    const words = [...document.querySelectorAll("p, li")].filter((element) =>
      element.textContent?.includes("start early"),
    );
    const last = words.at(-1)?.getBoundingClientRect();
    const button = copy.getBoundingClientRect();
    const glyph = icon.getBoundingClientRect();
    const style = getComputedStyle(copy);
    return {
      below: last ? Math.round(button.top - last.bottom) : null,
      // The icon's left edge against the words' left edge.
      indent: last ? Math.round(glyph.left - last.left) : null,
      button: [Math.round(button.width), Math.round(button.height)],
      icon: [Math.round(glyph.width), Math.round(glyph.height)],
      colour: style.color,
      background: style.backgroundColor,
      radius: style.borderRadius,
      inside: button.left >= -0.5 && button.right <= innerWidth + 0.5,
      sideways: document.documentElement.scrollWidth > innerWidth,
    };
  });
}

describe.skipIf(!asked)("a conversation's finished reply", () => {
  for (const engine of engines)
    for (const theme of THEMES)
      for (const window of WINDOWS)
        test(`has the Bot chat page's Copy under it, in ${engine}, ${theme}, ${window.width}px`, async () => {
          const conversation = await open(
            engine,
            theme,
            window,
            "conversation",
          );
          const bot = await open(engine, theme, window, "bot");
          try {
            if (shots) {
              mkdirSync(shots, { recursive: true });
              for (const [name, page] of [
                ["conversation", conversation],
                ["bot", bot],
              ] as const)
                await page.screenshot({
                  path: join(
                    shots,
                    `reply-toolbar-${name}-${engine}-${theme}-${window.width}.png`,
                  ),
                });
            }
            const ours = await measured(conversation);
            const theirs = await measured(bot);
            expect(ours.inside).toBe(true);
            expect(ours.sideways).toBe(false);
            // Under the reply's last words, as far below them as on the Bot chat page.
            expect(
              Math.abs((ours.below ?? -99) - (theirs.below ?? 99)),
            ).toBeLessThanOrEqual(2);
            // Lined up with the words as it is there, to the pixel the two layouts round to.
            expect(
              Math.abs((ours.indent ?? -99) - (theirs.indent ?? 99)),
            ).toBeLessThanOrEqual(1);
            // Drawn as the Bot chat page draws it.
            expect({
              button: ours.button,
              icon: ours.icon,
              colour: ours.colour,
              background: ours.background,
              radius: ours.radius,
            }).toEqual({
              button: theirs.button,
              icon: theirs.icon,
              colour: theirs.colour,
              background: theirs.background,
              radius: theirs.radius,
            });
          } finally {
            await conversation.close();
            await bot.close();
          }
        }, 60_000);
});
