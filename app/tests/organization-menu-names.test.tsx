import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Browser, BrowserType, Page } from "playwright-core";
import { compile } from "tailwindcss";

/**
 * An organization's name reads whole in the account menu.
 *
 * Seen in an end-to-end test: the menu's row read "Ana Lindqvist's organizati..." with nothing to
 * show the rest. The menu was exactly as wide as the account row, so at the sidebar's narrowest a
 * person's own organization was cut. The menu now grows to its words, up to a limit and never past
 * the window, and a name still cut reads whole in a tooltip, on hover and when the row is
 * highlighted from the keyboard, as the account row's own tooltip does.
 *
 * Rendered in a real Chromium, because where text is cut is the browser's layout to decide. The menu
 * is the real account row and organization rows with the app's stylesheet, at the sidebar's width
 * before anybody drags it (340px), at the narrowest it can be dragged to (220px), and as wide as
 * the sheet a 700px window opens it in (18rem).
 *
 *   OPENBOT_APP_BROWSER=1 bun test app/tests/organization-menu-names.test.tsx
 *
 * With OPENBOT_APP_SHOTS=<dir> it also saves the open menu with a short and a long name, and the
 * tooltip, in Chromium and WebKit, light and dark, in a 1440px and a 700px window, as
 * organization-menu-<engine>-<theme>-<window>.png and organization-menu-...-tooltip.png.
 */
const asked = process.env.OPENBOT_APP_BROWSER === "1";
const shots = process.env.OPENBOT_APP_SHOTS;

const APP = join(import.meta.dir, "..");
const ORIGIN = "http://openbot.test";

/** `SIDEBAR_WIDTH` and `SIDEBAR_MIN_WIDTH` in app/src/lib/sidebar.ts. */
const WIDTHS = [340, 220] as const;
/** `SIDEBAR_WIDTH_MOBILE` in app/src/components/ui/sidebar.tsx, the sheet a narrow window opens. */
const SHEET = 288;
/** The name OpenBot gives a person's own organization, as it was seen cut. */
const ORGANIZATION = "Ana Lindqvist's organization";
/** Too long for the menu at any width the sidebar can be. */
const LONG_ORGANIZATION =
  "Alexandria Montgomery-Fitzwilliam's organization for northern research";

async function bundle(): Promise<string> {
  const built = await Bun.build({
    entrypoints: [join(import.meta.dir, "organization-menu-names.fixture.tsx")],
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

let browser: Browser;
let script: string;
let css: string;

beforeAll(async () => {
  if (!asked) return;
  script = await bundle();
  // The menu and the tooltip are drawn only once open, so the classes are read from their source.
  const sources = [
    "components/ui/tooltip.tsx",
    "components/ui/dropdown-menu.tsx",
    "components/ui/sidebar.tsx",
    "components/app-sidebar/account-label.tsx",
    "components/layout/openbot-version.tsx",
    "components/organizations/organization-menu.tsx",
    "../tests/organization-menu-names.fixture.tsx",
  ].flatMap((file) =>
    readFileSync(join(APP, "src", file), "utf8").split(/[\s"'`{}]+/),
  );
  css = await stylesheet([...new Set(sources)].sort());
  const { chromium } = await import("playwright-core");
  // The CI job installs full Chromium without the headless shell.
  browser = await chromium.launch({ channel: "chromium" });
});

afterAll(async () => {
  await browser?.close();
});

type Look = {
  /** The window's width; the sidebar sits at its left edge. */
  window?: number;
  also?: string[];
  theme?: "light" | "dark";
  /** Another browser to draw it in, for the screenshots. */
  on?: Browser;
};

/** The account row in a sidebar `width` wide, styled, for a person whose own organization is `organization`. */
async function open(
  width: number,
  organization: string,
  { window = 1440, also = [], theme = "light", on = browser }: Look = {},
): Promise<Page> {
  const page = await on.newPage({
    viewport: { width: window, height: 520 },
    deviceScaleFactor: 2,
  });
  page.on("pageerror", (error) => console.error(error));
  const inter = join(packageDir("@fontsource-variable/inter"), "files");
  await page.route(`${ORIGIN}/**`, (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/")
      return route.fulfill({
        contentType: "text/html",
        body: `<!doctype html><html lang="en" class="${theme}"><head><meta charset="utf-8"></head><body class="bg-background text-foreground"><div id="root"></div><script type="module" src="/menu.js"></script></body></html>`,
      });
    if (path === "/menu.js")
      return route.fulfill({ contentType: "text/javascript", body: script });
    const font = join(inter, path.split("/").pop() ?? "");
    if (path.startsWith("/files/") && existsSync(font))
      return route.fulfill({ path: font });
    return route.fulfill({ status: 404 });
  });
  const query = new URLSearchParams({ width: String(width), organization });
  for (const name of also) query.append("also", name);
  await page.goto(`${ORIGIN}/?${query}`);
  await page.addStyleTag({ content: css });
  await page.locator("[data-sidebar=menu-button]").waitFor();
  await page.evaluate(() => document.fonts.ready);
  return page;
}

/** The menu's row for `name`. */
function row(page: Page, name: string) {
  return page.locator('[role="menuitemradio"]').filter({ hasText: name });
}

/** Whether the row's name is cut, and where the menu sits in the window. */
async function measured(page: Page, name: string) {
  return row(page, name).evaluate((item, name) => {
    const line = [...item.querySelectorAll<HTMLElement>("span")].find(
      (span) => span.children.length === 0 && span.textContent === name,
    ) as HTMLElement;
    const menu = item.closest('[role="menu"]') as HTMLElement;
    const box = menu.getBoundingClientRect();
    return {
      cut: line.scrollWidth > line.clientWidth,
      menuInsideWindow: box.left >= 0 && box.right <= window.innerWidth,
    };
  }, name);
}

/** What the tooltip says, once one shows; null when none shows. */
async function tooltip(page: Page): Promise<string | null> {
  const popup = page.locator('[data-slot="tooltip-content"]');
  try {
    await popup.waitFor({ state: "visible", timeout: 3_000 });
  } catch {
    return null;
  }
  return popup.innerText();
}

describe.skipIf(!asked)("an organization's name in the account menu", () => {
  for (const [label, width, window] of [
    ["the sidebar's own width", WIDTHS[0], 1440],
    ["the sidebar's narrowest", WIDTHS[1], 1440],
    ["a 700px window's sheet", SHEET, 700],
  ] as const) {
    test(`at ${label}, ${ORGANIZATION} reads whole`, async () => {
      const page = await open(width, ORGANIZATION, { window });
      try {
        await page.locator("[data-sidebar=menu-button]").click();
        await row(page, ORGANIZATION).waitFor();
        expect(await measured(page, ORGANIZATION)).toEqual({
          cut: false,
          menuInsideWindow: true,
        });
      } finally {
        await page.close();
      }
    }, 60_000);
  }

  for (const width of WIDTHS) {
    test(`at ${width}px, a name still cut reads whole on hover`, async () => {
      const page = await open(width, LONG_ORGANIZATION);
      try {
        await page.locator("[data-sidebar=menu-button]").click();
        await row(page, LONG_ORGANIZATION).waitFor();
        expect(await measured(page, LONG_ORGANIZATION)).toEqual({
          cut: true,
          menuInsideWindow: true,
        });
        await row(page, LONG_ORGANIZATION).hover();
        expect(await tooltip(page)).toBe(LONG_ORGANIZATION);
      } finally {
        await page.close();
      }
    }, 60_000);

    test(`at ${width}px, a name still cut reads whole when the keyboard highlights its row`, async () => {
      const page = await open(width, LONG_ORGANIZATION);
      try {
        // Into the account row, open its menu, and down from Acme to the person's own organization.
        await page.keyboard.press("Tab");
        await page.keyboard.press("Enter");
        await row(page, "Acme").waitFor();
        await page.keyboard.press("ArrowDown");
        const highlighted = row(page, LONG_ORGANIZATION);
        // The menu highlights a row by giving it focus.
        await highlighted.and(page.locator(":focus")).waitFor();
        expect(await tooltip(page)).toBe(LONG_ORGANIZATION);
        // The row's own name for assistive technology is the whole name: cutting it is only paint.
        expect(await highlighted.textContent()).toBe(LONG_ORGANIZATION);

        // On to the next row, and the tooltip goes with the highlight.
        await page.keyboard.press("ArrowDown");
        await page
          .locator('[data-slot="tooltip-content"]')
          .waitFor({ state: "hidden" });
      } finally {
        await page.close();
      }
    }, 60_000);
  }

  test("a name that reads whole offers no tooltip", async () => {
    const page = await open(WIDTHS[1], ORGANIZATION);
    try {
      await page.locator("[data-sidebar=menu-button]").click();
      await row(page, ORGANIZATION).hover();
      expect(await tooltip(page)).toBeNull();
    } finally {
      await page.close();
    }
  }, 60_000);

  test.skipIf(!shots)(
    "screenshots in Chromium and WebKit, light and dark, wide and narrow",
    async () => {
      if (!shots) return;
      mkdirSync(shots, { recursive: true });
      const { webkit } = await import("playwright-core");
      const engines: [string, Browser][] = [
        ["chromium", browser],
        ["webkit", await (webkit as BrowserType).launch()],
      ];
      try {
        for (const [engine, on] of engines)
          for (const theme of ["light", "dark"] as const)
            for (const [window, width] of [
              [1440, WIDTHS[0]],
              [1440, WIDTHS[1]],
              [700, SHEET],
            ] as const) {
              const page = await open(width, ORGANIZATION, {
                window,
                also: [LONG_ORGANIZATION],
                theme,
                on,
              });
              try {
                const name = `organization-menu-${engine}-${theme}-${window}-${width}`;
                await page.locator("[data-sidebar=menu-button]").click();
                await row(page, LONG_ORGANIZATION).waitFor();
                await page.mouse.move(window - 10, 10);
                const clip = {
                  x: 0,
                  y: 120,
                  width: Math.min(window, 820),
                  height: 400,
                };
                await page.screenshot({
                  path: join(shots, `${name}.png`),
                  clip,
                  animations: "disabled",
                });
                await row(page, LONG_ORGANIZATION).hover();
                if (await tooltip(page))
                  await page.screenshot({
                    path: join(shots, `${name}-tooltip.png`),
                    clip,
                    // As it rests, not partway through fading in.
                    animations: "disabled",
                  });
              } finally {
                await page.close();
              }
              // And from the keyboard: into the account row, open its menu, down to the long name.
              const keyboard = await open(width, ORGANIZATION, {
                window,
                also: [LONG_ORGANIZATION],
                theme,
                on,
              });
              try {
                await keyboard.keyboard.press("Tab");
                await keyboard.keyboard.press("Enter");
                await row(keyboard, "Acme").waitFor();
                await keyboard.keyboard.press("ArrowDown");
                await keyboard.keyboard.press("ArrowDown");
                await row(keyboard, LONG_ORGANIZATION)
                  .and(keyboard.locator(":focus"))
                  .waitFor();
                if (await tooltip(keyboard))
                  await keyboard.screenshot({
                    path: join(
                      shots,
                      `organization-menu-${engine}-${theme}-${window}-${width}-keyboard.png`,
                    ),
                    clip: {
                      x: 0,
                      y: 120,
                      width: Math.min(window, 820),
                      height: 400,
                    },
                    animations: "disabled",
                  });
              } finally {
                await keyboard.close();
              }
            }
      } finally {
        await engines[1]?.[1].close();
      }
    },
    240_000,
  );
});
