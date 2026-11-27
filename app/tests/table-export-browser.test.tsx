import { afterAll, beforeAll, describe, expect } from "bun:test";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Browser, Page } from "playwright-core";
import { compile } from "tailwindcss";
import { marksPlugin } from "./marks-plugin";
import { test } from "./renderer-crash";

/**
 * A table of links a Bot writes, downloaded from the table's own controls in a real browser, keeps
 * its links, and the table looks exactly as Streamdown's own table did.
 *
 * Seen on 2026-11-24 (1.2.0-rc.4): Download as Markdown saved `| Release | OpenBot release notes |`,
 * with no address, while the reply itself kept `[OpenBot release notes](<https://…>)`. OpenBot now
 * draws the table itself so its Copy and Download can write the links; this checks that the file
 * the browser saves has them, and that nothing a person sees changed: the table, its download and
 * copy menus, and its fullscreen view, pixel for pixel against Streamdown's.
 *
 * And a table with one cell that wraps to many lines reads from the top of its row: the short cells
 * beside it start on its first line, in a reply, a card's text and a generated interface, on a phone
 * and wide, and full screen. Seen on 2026-11-26 on a phone: Streamdown sets a cell in the middle of
 * its row, so "200 in your team's" sat halfway down beside a tall list of people.
 *
 *   OPENBOT_APP_BROWSER=1 bun test app/tests/table-export-browser.test.tsx
 *
 * Chromium by default. OPENBOT_APP_ENGINES=chromium,webkit adds WebKit. With
 * OPENBOT_APP_SHOTS=<dir> each page is saved as table-<engine>-<theme>-<surface>-<state>.png, and
 * each wrapping table as wrapping-<engine>-<theme>-<surface>-<width>-<view>.png.
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
const SURFACES = ["transcript", "ours", "streamdown"] as const;
/** Every surface that draws a Bot's markdown with the reply's renderer. */
const RENDERERS = ["transcript", "gallery", "a2ui"] as const;
type Surface = (typeof SURFACES)[number] | (typeof RENDERERS)[number];
type Reply = "links" | "wrapping";
/** The words of each reply's last cell, there once the whole reply is drawn. */
const LAST: Record<Reply, string> = {
  links: "no link here",
  wrapping: "Linus Pauling",
};
/** A phone's width, and a computer's. */
const WIDTHS = [390, 900] as const;

const RELEASE =
  "https://github.com/CopilotKit/OpenBot/releases/tag/v1.2.0-rc.4";
const GUIDE = "https://docs.example.com/guide_(beta)";
const PLAN = "https://docs.google.com/document/d/q3-plan";

/** The fixture and what it imports, built for a browser. */
async function bundle(): Promise<Map<string, { type: string; body: Blob }>> {
  const built = await Bun.build({
    entrypoints: [join(import.meta.dir, "table-export-browser.fixture.tsx")],
    target: "browser",
    naming: { entry: "fixture.[ext]", asset: "[name].[ext]" },
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    plugins: [marksPlugin],
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

async function open(
  engine: "chromium" | "webkit",
  theme: (typeof THEMES)[number],
  surface: Surface,
  {
    styled = true,
    reply = "links",
    width = 900,
  }: { styled?: boolean; reply?: Reply; width?: number } = {},
): Promise<Page> {
  const browser = await browserFor(engine);
  const page = await browser.newPage({
    viewport: { width, height: 700 },
    deviceScaleFactor: 2,
    acceptDownloads: true,
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
  await page.goto(
    `${ORIGIN}/?surface=${surface}&theme=${theme}&reply=${reply}`,
  );
  // The reply is revealed at a reading pace in a conversation; its table's last row ends it.
  await page.getByText(LAST[reply]).first().waitFor({ timeout: 20_000 });
  await settle(page);
  return page;
}

/** Lets what fades in finish, so two pages are read at rest. */
function settle(page: Page) {
  return page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.race([
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
    ]);
  });
}

/** The table's states a person sees, each reached from the table at rest. */
const STATES = ["rest", "download-menu", "copy-menu", "fullscreen"] as const;

async function show(page: Page, state: (typeof STATES)[number]) {
  if (state === "download-menu")
    await page.getByTitle("Download table").first().click();
  if (state === "copy-menu")
    await page.getByTitle("Copy table").first().click();
  if (state === "fullscreen") {
    await page.getByTitle("View fullscreen").first().click();
    await page.locator('[data-streamdown="table-fullscreen"]').waitFor();
  }
  // Moves the pointer off the button it pressed, so no hover colour is left on either page.
  await page.mouse.move(0, 0);
  await settle(page);
}

beforeAll(async () => {
  if (!asked) return;
  files = await bundle();
  const classes = new Set<string>();
  const pages = [
    ...SURFACES.map((surface) => ({ surface, reply: "links" as const })),
    ...RENDERERS.map((surface) => ({ surface, reply: "wrapping" as const })),
  ];
  for (const { surface, reply } of pages)
    for (const state of STATES) {
      const page = await open("chromium", "light", surface, {
        styled: false,
        reply,
      });
      try {
        await show(page, state);
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
}, 180_000);

afterAll(async () => {
  await Promise.all([...browsers.values()].map((browser) => browser.close()));
});

async function shoot(page: Page, name: string) {
  const image = await page.screenshot({ fullPage: true });
  if (shots) {
    mkdirSync(shots, { recursive: true });
    await Bun.write(join(shots, `${name}.png`), image);
  }
  return image;
}

/**
 * How many pixels differ between two screenshots, decoded and compared in the browser.
 *
 * Two loads of the very same page differ by a handful of pixels in the soft edge of a menu's shadow
 * or a line's anti-aliasing, so a count is compared rather than the bytes. A real change of look (a
 * pixel of padding, another icon, another colour) moves thousands.
 */
function differingPixels(page: Page, first: Buffer, second: Buffer) {
  return page.evaluate(
    async ([a, b]) => {
      const read = async (base64: string) => {
        const image = new Image();
        image.src = `data:image/png;base64,${base64}`;
        await image.decode();
        const canvas = document.createElement("canvas");
        canvas.width = image.width;
        canvas.height = image.height;
        const context = canvas.getContext("2d");
        if (!context) throw new Error("no 2D canvas");
        context.drawImage(image, 0, 0);
        return context.getImageData(0, 0, image.width, image.height);
      };
      const [x, y] = await Promise.all([read(a), read(b)]);
      if (x.width !== y.width || x.height !== y.height)
        return Number.POSITIVE_INFINITY;
      let count = 0;
      for (let i = 0; i < x.data.length; i += 4)
        if (
          x.data[i] !== y.data[i] ||
          x.data[i + 1] !== y.data[i + 1] ||
          x.data[i + 2] !== y.data[i + 2]
        )
          count += 1;
      return count;
    },
    [first.toString("base64"), second.toString("base64")],
  );
}

/** Presses Download, then a format, and reads the file the browser saved. */
async function download(page: Page, format: "Markdown" | "CSV") {
  await page.getByTitle("Download table").first().click();
  const saving = page.waitForEvent("download");
  await page.getByRole("button", { name: format, exact: true }).click();
  const saved = await saving;
  const path = await saved.path();
  return { name: saved.suggestedFilename(), text: readFileSync(path, "utf8") };
}

describe.skipIf(!asked)("a table of links a Bot writes", () => {
  for (const engine of engines) {
    for (const theme of THEMES) {
      test(`${engine}, ${theme}: Download as Markdown and as CSV keep the links`, async () => {
        const page = await open(engine, theme, "transcript");
        try {
          await shoot(page, `table-${engine}-${theme}-transcript-rest`);
          const markdown = await download(page, "Markdown");
          expect(markdown.name).toBe("table.md");
          expect(markdown.text).toBe(
            [
              "| Item | Link |",
              "| --- | --- |",
              `| Release | [OpenBot release notes](${RELEASE}) |`,
              `| Guide | See [the guide](<${GUIDE}>) first |`,
              `| Plan | [Q3 plan](${PLAN}) |`,
              "| Plain | no link here |",
            ].join("\n"),
          );
          const csv = await download(page, "CSV");
          expect(csv.name).toBe("table.csv");
          expect(csv.text).toBe(
            [
              "\uFEFFItem,Link",
              `Release,OpenBot release notes (${RELEASE})`,
              `Guide,See the guide (${GUIDE}) first`,
              `Plan,Q3 plan (${PLAN})`,
              "Plain,no link here",
            ].join("\n"),
          );
        } finally {
          await page.close();
        }
      }, 60_000);

      for (const state of STATES)
        test(`${engine}, ${theme}, ${state}: the table looks exactly as Streamdown's`, async () => {
          const ours = await open(engine, theme, "ours");
          const theirs = await open(engine, theme, "streamdown");
          try {
            await show(ours, state);
            await show(theirs, state);
            const mine = await shoot(
              ours,
              `table-${engine}-${theme}-ours-${state}`,
            );
            const streamdown = await shoot(
              theirs,
              `table-${engine}-${theme}-streamdown-${state}`,
            );
            expect(await differingPixels(ours, mine, streamdown)).toBeLessThan(
              50,
            );
          } finally {
            await ours.close();
            await theirs.close();
          }
        }, 60_000);
    }
  }
});

/**
 * The row with the tall cell, read in the inline table or the fullscreen one: each cell's vertical
 * alignment, where its first line of words starts, and how many lines it runs to.
 */
function readRow(page: Page, view: "inline" | "fullscreen") {
  return page.evaluate((view) => {
    const scope =
      view === "fullscreen"
        ? document.querySelector('[data-streamdown="table-fullscreen"]')
        : document.querySelector('[data-streamdown="table-wrapper"]');
    const row = [...(scope?.querySelectorAll("tbody tr") ?? [])].find((tr) =>
      tr.textContent?.includes("Northwind"),
    );
    if (!row) throw new Error(`no row with the tall cell (${view})`);
    return [...row.querySelectorAll("td")].map((cell) => {
      const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
      let text = walker.nextNode();
      while (text && !text.textContent?.trim()) text = walker.nextNode();
      if (!text) throw new Error("a cell with no words");
      const range = document.createRange();
      range.selectNodeContents(text);
      const lines = [...range.getClientRects()];
      return {
        cell: (cell.textContent ?? "").trim().slice(0, 20),
        align: getComputedStyle(cell).verticalAlign,
        top: Math.round(lines[0].top),
        lines: new Set(lines.map((line) => Math.round(line.top))).size,
      };
    });
  }, view);
}

describe.skipIf(!asked)("a table whose one cell wraps to many lines", () => {
  for (const engine of engines)
    for (const surface of RENDERERS)
      for (const width of WIDTHS)
        test(`${engine}, ${surface}, ${width}px: every cell in a row starts at its top`, async () => {
          for (const theme of THEMES) {
            const page = await open(engine, theme, surface, {
              reply: "wrapping",
              width,
            });
            try {
              for (const view of ["inline", "fullscreen"] as const) {
                if (view === "fullscreen") await show(page, "fullscreen");
                await shoot(
                  page,
                  `wrapping-${engine}-${theme}-${surface}-${width}-${view}`,
                );
                const cells = await readRow(page, view);
                // The People cell does wrap, on any system's font, or the row would show nothing
                // either way.
                expect(
                  Math.max(...cells.map((cell) => cell.lines)),
                ).toBeGreaterThanOrEqual(3);
                const first = cells[0].top;
                expect(
                  cells.map(({ cell, align, top }) => ({ cell, align, top })),
                ).toEqual(
                  cells.map(({ cell }) => ({ cell, align: "top", top: first })),
                );
              }
            } finally {
              await page.close();
            }
          }
        }, 120_000);
});
