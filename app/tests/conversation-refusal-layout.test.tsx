import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Browser, BrowserType, Page } from "playwright-core";
import { compile } from "tailwindcss";
import { marksPlugin } from "./marks-plugin";

/**
 * A turn the server refused reads as the app's notice, and a short conversation has no stray rail.
 *
 * Seen on the per-team models end-to-end run: a run refused because the person's team doesn't
 * include the Bot's model was told in plain red text under the message, read as a fault in the
 * screen rather than something to act on. And beside two short turns a rail of two dashes sat in
 * the margin, a stray mark with nothing to move to: both turns were already in view.
 *
 * The real transcript is drawn in a real browser, bundled from the fixture beside this file, with
 * the app's stylesheet: the refusal is one outlined row (the app's `Item`) whose sentence is in the
 * foreground colour, inside the window at a phone's width as on a laptop; the rail of turns draws
 * only once the turns run past the window. Light and dark, 390 and 1440.
 *
 *   OPENBOT_APP_BROWSER=1 bun test app/tests/conversation-refusal-layout.test.tsx
 *
 * Chromium by default, as CI has it. OPENBOT_APP_ENGINES=chromium,webkit adds WebKit. With
 * OPENBOT_APP_SHOTS=<dir> each is saved as conversation-refusal-<turns>-<engine>-<theme>-<width>.png.
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
      join(import.meta.dir, "conversation-refusal-layout.fixture.tsx"),
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

/** The conversation with `turns` turns, the last refused, styled once it has drawn. */
async function open(
  engine: string,
  theme: (typeof THEMES)[number],
  window: { width: number; height: number },
  turns: number,
  /** How many turns at the end were refused one after another, each under its own message. */
  refusedInARow = 0,
  /** Opened again: the refused turns come back from the server's record, not the screen's memory. */
  reloaded?: "person" | "routine",
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
  await page.goto(
    `${ORIGIN}/?turns=${turns}&refusedInARow=${refusedInARow}${reloaded ? `&reloaded=${reloaded}` : ""}`,
  );
  await page.getByTestId("transcript-stopped").first().waitFor();
  await style(page);
  await page.evaluate(() => document.fonts.ready);
  /*
   * The turns are measured against the styled window a frame after it is styled, and the rail
   * (where it is drawn) appears then. Styled again, for its own classes.
   */
  await page.waitForTimeout(300);
  await style(page);
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

/** How the refusal is drawn, and whether the rail of turns is. */
function drawn(page: Page) {
  return page.evaluate(() => {
    const notice = document.querySelector(
      "[data-testid=transcript-stopped]",
    ) as HTMLElement;
    const sentence = notice.querySelector("[role=alert]") as HTMLElement;
    const style = getComputedStyle(notice);
    const box = notice.getBoundingClientRect();
    // The colours the page's words and ground are drawn in, from the column the transcript sits in.
    const page = getComputedStyle(
      document.querySelector("#root > div") ?? document.body,
    );
    const words = page.color;
    const clear = (colour: string) =>
      /rgba\(0, 0, 0, 0\)|transparent/.test(colour);
    const rail = document.querySelector('nav[aria-label="Turns"]');
    return {
      row: notice.dataset.slot,
      variant: notice.dataset.variant,
      /*
       * Outlined in both themes, as every card in a conversation is: an edge that shows against the
       * notice's own fill. In dark it was a filled block with no edge (the row's border gives way
       * there unless the card keeps it).
       */
      edged:
        style.borderTopWidth !== "0px" &&
        !clear(style.borderTopColor) &&
        style.borderTopColor !== style.backgroundColor,
      sentenceInWordsColour: getComputedStyle(sentence).color === words,
      inside: box.left >= -0.5 && box.right <= innerWidth + 0.5,
      sideways: document.documentElement.scrollWidth > innerWidth,
      rail: rail !== null && getComputedStyle(rail).display !== "none",
    };
  });
}

describe.skipIf(!asked)("a turn the server refused", () => {
  for (const engine of engines)
    for (const theme of THEMES)
      for (const window of WINDOWS)
        test(`reads as the app's notice, with no stray rail, in ${engine}, ${theme}, ${window.width}px`, async () => {
          const page = await open(engine, theme, window, 2);
          try {
            if (shots) {
              mkdirSync(shots, { recursive: true });
              await page.screenshot({
                path: join(
                  shots,
                  `conversation-refusal-2-${engine}-${theme}-${window.width}.png`,
                ),
              });
            }
            expect(await drawn(page)).toEqual({
              row: "item",
              variant: "outline",
              edged: true,
              sentenceInWordsColour: true,
              inside: true,
              sideways: false,
              // Both turns are in view: there is nowhere for a rail to take anybody.
              rail: false,
            });
          } finally {
            await page.close();
          }
        }, 60_000);

  /*
   * Two turns refused one after the other: each keeps its own notice, drawn under its own message
   * and before the next one, edged in both themes. Seen on the end-to-end run: the second refusal
   * took the first one's notice away, and the first message read as never answered.
   */
  /*
   * And after a reload, where nothing of either is in the thread: both messages and both notices
   * come back from the server's record of the refused turns, each notice under its own message.
   */
  for (const when of ["live", "reloaded"] as const)
    for (const engine of engines)
      for (const theme of THEMES)
        for (const window of WINDOWS)
          test(`two turns refused in a row each keep their notice under their message, ${when}, in ${engine}, ${theme}, ${window.width}px`, async () => {
            const page =
              when === "live"
                ? await open(engine, theme, window, 1, 2)
                : await open(engine, theme, window, 1, 0, "person");
            try {
              if (shots) {
                mkdirSync(shots, { recursive: true });
                await page.screenshot({
                  path: join(
                    shots,
                    `conversation-refused-twice-${when}-${engine}-${theme}-${window.width}.png`,
                  ),
                });
              }
              const placed = await page.evaluate(() => {
                const notices = [
                  ...document.querySelectorAll(
                    "[data-testid=transcript-stopped]",
                  ),
                ] as HTMLElement[];
                const said = (words: string) =>
                  [...document.querySelectorAll("p, span, div")]
                    .filter((element) => element.textContent === words)
                    .at(-1)
                    ?.getBoundingClientRect();
                const first = said("Say goodbye in one word.");
                const second = said("And once more, one word.");
                const boxes = notices.map((notice) =>
                  notice.getBoundingClientRect(),
                );
                const edged = notices.every((notice) => {
                  const style = getComputedStyle(notice);
                  return (
                    style.borderTopWidth !== "0px" &&
                    !/rgba\(0, 0, 0, 0\)|transparent/.test(
                      style.borderTopColor,
                    ) &&
                    style.borderTopColor !== style.backgroundColor
                  );
                });
                return {
                  count: notices.length,
                  // The first notice between its message and the next; the second under the next.
                  firstUnderItsMessage:
                    !!first &&
                    !!second &&
                    !!boxes[0] &&
                    boxes[0].top >= first.bottom &&
                    boxes[0].bottom <= second.top,
                  secondUnderItsMessage:
                    !!second && !!boxes[1] && boxes[1].top >= second.bottom,
                  edged,
                  inside: boxes.every(
                    (box) => box.left >= -0.5 && box.right <= innerWidth + 0.5,
                  ),
                };
              });
              expect(placed).toEqual({
                count: 2,
                firstUnderItsMessage: true,
                secondUnderItsMessage: true,
                edged: true,
                inside: true,
              });
            } finally {
              await page.close();
            }
          }, 60_000);

  /*
   * A routine's turn refused, after a reload: drawn as the transcript draws a routine's turn, saying
   * it didn't run ("Routine didn't run." and what it asked, never "Routine ran."), with the refusal
   * under it.
   */
  for (const engine of engines)
    for (const theme of THEMES)
      for (const window of WINDOWS)
        test(`a routine's refused turn comes back with its notice under it, in ${engine}, ${theme}, ${window.width}px`, async () => {
          const page = await open(engine, theme, window, 1, 0, "routine");
          try {
            if (shots) {
              mkdirSync(shots, { recursive: true });
              await page.screenshot({
                path: join(
                  shots,
                  `conversation-routine-refused-reloaded-${engine}-${theme}-${window.width}.png`,
                ),
              });
            }
            const placed = await page.evaluate(() => {
              const ran = [...document.querySelectorAll("span")]
                .find(
                  (element) => element.textContent === "Routine didn't run.",
                )
                ?.closest("[data-slot=message-scroller-item]");
              const notice = ran?.querySelector(
                "[data-testid=transcript-stopped]",
              );
              return {
                asked: ran?.textContent?.includes("Say hello in one word."),
                noticeUnderIt: notice !== null && notice !== undefined,
                notices: document.querySelectorAll(
                  "[data-testid=transcript-stopped]",
                ).length,
                saysRan: document.body.textContent?.includes("Routine ran."),
                sideways: document.documentElement.scrollWidth > innerWidth,
              };
            });
            expect(placed).toEqual({
              asked: true,
              noticeUnderIt: true,
              notices: 1,
              saysRan: false,
              sideways: false,
            });
          } finally {
            await page.close();
          }
        }, 60_000);

  // The rail still draws where it is for: turns running past the window, in a window wide enough.
  for (const engine of engines)
    test(`a long conversation still has its rail of turns, in ${engine}`, async () => {
      const page = await open(engine, "light", WINDOWS[1] as never, 12);
      try {
        if (shots) {
          mkdirSync(shots, { recursive: true });
          await page.screenshot({
            path: join(
              shots,
              `conversation-refusal-12-${engine}-light-1440.png`,
            ),
          });
        }
        expect((await drawn(page)).rail).toBe(true);
      } finally {
        await page.close();
      }
    }, 60_000);
});
