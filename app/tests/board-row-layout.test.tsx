import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Browser, BrowserType, Page } from "playwright-core";
import { compile } from "tailwindcss";

/**
 * A Needs you board row keeps its words readable at every width the board is drawn at.
 *
 * Seen on a phone and at chat width: a stopped task's row put Try again, Mark done and Open beside
 * its title, and the title and its line were squeezed into a column a word or two wide ("Res…",
 * "You…"), with "25 minutes ago" broken over three lines. Where the row is too narrow for its words
 * and its buttons side by side, the buttons now go under the words, lined up with them.
 *
 * Rendered in real browsers, because where a row wraps is the browser's layout to decide. The rows
 * are the real component with the app's stylesheet.
 *
 *   OPENBOT_APP_BROWSER=1 bun test app/tests/board-row-layout.test.tsx
 *
 * With OPENBOT_APP_SHOTS=<dir> it also saves the rows at each width, light and dark, in each
 * browser, as board-row-<browser>-<width>-<theme>.png.
 */
const asked = process.env.OPENBOT_APP_BROWSER === "1";
const shots = process.env.OPENBOT_APP_SHOTS;

const APP = join(import.meta.dir, "..");
const ORIGIN = "http://openbot.test";

/**
 * The column the board is drawn in: a phone, OpenBot Desktop's default window less its sidebar (as
 * update-banner-layout.test.tsx measured it), and the widest a page's column gets (`PageShell`'s
 * prose width).
 */
const WIDTHS = { phone: 390, chat: 650, wide: 768 } as const;

async function bundle(): Promise<string> {
  const built = await Bun.build({
    entrypoints: [join(import.meta.dir, "board-row-layout.fixture.tsx")],
    target: "browser",
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
  });
  if (!built.success) throw new AggregateError(built.logs, "bundle failed");
  const script = built.outputs.find((output) => output.kind === "entry-point");
  if (!script) throw new Error("bundle has no entry point");
  return script.text();
}

function packageDir(name: string): string {
  const dir = [
    join(APP, "node_modules", name),
    join(APP, "..", "node_modules", name),
  ].find(existsSync);
  if (!dir) throw new Error(`no package ${name}`);
  return dir;
}

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
let css: string | undefined;
const browsers: { name: string; browser: Browser }[] = [];

beforeAll(async () => {
  if (!asked) return;
  script = await bundle();
  const playwright = await import("playwright-core");
  const launch = async (name: string, type: BrowserType, channel?: string) => {
    try {
      browsers.push({
        name,
        browser: await type.launch(channel ? { channel } : {}),
      });
    } catch (error) {
      // WebKit is looked at where it is installed; Chromium is required.
      if (name === "chromium") throw error;
      console.warn(`${name} not installed, skipped: ${String(error)}`);
    }
  };
  await launch("chromium", playwright.chromium, "chromium");
  await launch("webkit", playwright.webkit);
});

afterAll(async () => {
  for (const { browser } of browsers) await browser.close();
});

async function open(
  browser: Browser,
  width: number,
  theme: "light" | "dark" = "light",
): Promise<Page> {
  const page = await browser.newPage({
    viewport: { width, height: 400 },
    deviceScaleFactor: 2,
  });
  page.on("pageerror", (error) => console.error(error));
  const inter = join(packageDir("@fontsource-variable/inter"), "files");
  await page.route(`${ORIGIN}/**`, (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/")
      return route.fulfill({
        contentType: "text/html",
        body: `<!doctype html><html lang="en" class="${theme}"><head><meta charset="utf-8"></head><body class="bg-background text-foreground"><div id="root"></div><script type="module" src="/rows.js"></script></body></html>`,
      });
    if (path === "/rows.js")
      return route.fulfill({ contentType: "text/javascript", body: script });
    const font = join(inter, path.split("/").pop() ?? "");
    if (path.startsWith("/files/") && existsSync(font))
      return route.fulfill({ path: font });
    return route.fulfill({ status: 404 });
  });
  await page.goto(`${ORIGIN}/?width=${width}`);
  await page.locator("[data-row=ready] [data-slot=item-title]").waitFor();
  if (!css) {
    const classes = await page.evaluate(() => [
      ...new Set(
        [...document.querySelectorAll("[class]")].flatMap((element) => [
          ...element.classList,
        ]),
      ),
    ]);
    css = await stylesheet([...classes, "bg-background", "text-foreground"]);
  }
  await page.addStyleTag({ content: css });
  await page.evaluate(() => document.fonts.ready);
  return page;
}

/** Where a row's words and its buttons are drawn. */
async function measured(page: Page, row: string) {
  return page.evaluate((name) => {
    const box = (element: Element | null | undefined) => {
      const rect = element?.getBoundingClientRect();
      return rect
        ? {
            left: rect.left,
            right: rect.right,
            top: rect.top,
            bottom: rect.bottom,
            width: rect.width,
          }
        : null;
    };
    const item = document.querySelector(`[data-row=${name}] [data-slot=item]`);
    const title = item?.querySelector("[data-slot=item-title]");
    const words = title?.closest("button") ?? title?.parentElement;
    const detail = title?.nextElementSibling as HTMLElement | null | undefined;
    return {
      detail: detail
        ? {
            text: detail.textContent ?? "",
            cut: detail.scrollHeight > detail.clientHeight + 1,
          }
        : null,
      row: box(item),
      words: box(words),
      buttons: [...(item?.querySelectorAll("button, a") ?? [])]
        .filter((element) => element !== words)
        .map((element) => ({
          text: element.textContent ?? "",
          ...box(element),
        })),
    };
  }, row);
}

describe.skipIf(!asked)("a Needs you board row", () => {
  for (const [label, width] of Object.entries(WIDTHS)) {
    test(`at ${label} width (${width}px), its words get at least half the row and every button shows whole`, async () => {
      for (const { name, browser } of browsers) {
        const page = await open(browser, width);
        try {
          for (const row of ["stopped", "waiting", "ready"]) {
            const seen = await measured(page, row);
            if (!seen.row || !seen.words) throw new Error(`no ${row} row`);
            const share = seen.words.width / seen.row.width;
            expect({ browser: name, row, wordsGetHalf: share >= 0.5 }).toEqual({
              browser: name,
              row,
              wordsGetHalf: true,
            });
            for (const button of seen.buttons) {
              // Inside the row, and never drawn over the words.
              expect({
                browser: name,
                row,
                button: button.text,
                inside: button.right! <= seen.row.right + 0.5,
                clear:
                  button.left! >= seen.words.right - 0.5 ||
                  button.top! >= seen.words.bottom - 0.5,
              }).toEqual({
                browser: name,
                row,
                button: button.text,
                inside: true,
                clear: true,
              });
            }
          }
        } finally {
          await page.close();
        }
      }
    }, 60_000);
  }

  for (const [label, width] of Object.entries(WIDTHS)) {
    test(`at ${label} width (${width}px), what a waiting task waits for is read in full, not cut short`, async () => {
      for (const { name, browser } of browsers) {
        const page = await open(browser, width);
        try {
          const seen = await measured(page, "waiting");
          expect({ browser: name, detail: seen.detail }).toEqual({
            browser: name,
            detail: {
              text: "Waiting for your approval: hand this to Pipeline Bot, which acts as Dana and can read the deals pipeline",
              cut: false,
            },
          });
        } finally {
          await page.close();
        }
      }
    }, 60_000);
  }

  test.skipIf(!shots)(
    "screenshots at each width",
    async () => {
      if (!shots) return;
      mkdirSync(shots, { recursive: true });
      for (const { name, browser } of browsers)
        for (const [label, width] of Object.entries(WIDTHS))
          for (const theme of ["light", "dark"] as const) {
            const page = await open(browser, width, theme);
            try {
              await page.screenshot({
                path: join(shots, `board-row-${name}-${label}-${theme}.png`),
                fullPage: true,
              });
            } finally {
              await page.close();
            }
          }
    },
    180_000,
  );
});
