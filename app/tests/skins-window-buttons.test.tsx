import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Browser, Page } from "playwright-core";
import { compile } from "tailwindcss";

/**
 * Every skin's top-left corner stays clear of the window's buttons in OpenBot Desktop on macOS.
 *
 * The Mac window's close, minimise and zoom buttons sit over the page's top-left corner, 20pt in
 * and 21–37pt down (`TRAFFIC_LIGHTS` in the desktop's main.rs). The desktop marks the page with
 * `data-desktop-titlebar="overlay"` on macOS only, and OpenBot's own sidebar and onboarding make
 * room for them. A skin draws its own frame in place of the sidebar, so it makes its own room:
 * OpenDuet's menu drawer once had the "OpenBot" wordmark under the buttons, and its back disc sat
 * under them on every page opened over the app.
 * Windows has its own title bar above the page and no such mark, so nothing moves there.
 *
 * Rendered in a real Chromium, because what matters is where things land once the browser has laid
 * the frame out. The frames are the skins' own, with the app's stylesheet; only OpenBot's API is
 * a fake (skins-window-buttons.fixture.tsx).
 *
 *   OPENBOT_APP_BROWSER=1 bun test app/tests/skins-window-buttons.test.tsx
 *
 * With OPENBOT_APP_SHOTS=<dir> it also saves each corner, light and dark, with the buttons' area
 * outlined, as skins-window-buttons-<case>-<theme>.png.
 */
const asked = process.env.OPENBOT_APP_BROWSER === "1";
const shots = process.env.OPENBOT_APP_SHOTS;

const APP = join(import.meta.dir, "..");
const ORIGIN = "http://openbot.test";

/** Where macOS draws the window's buttons over the page, as measured in OpenBot Desktop on macOS 26. */
const WINDOW_BUTTONS = { left: 19, top: 21, right: 81, bottom: 37 };

/** The desktop window's default width, and the narrowest it allows (desktop's tauri.conf.json). */
const DEFAULT_WIDTH = 1000;
const NARROWEST_WIDTH = 720;

type Case = {
  name: string;
  skin: "openduet" | "opendots" | "openfuse";
  path: string;
  width: number;
  /** Whether the desktop app offers an update, so the update notice is drawn across the top. */
  update?: boolean;
  /** What to do once the frame is drawn, such as opening a drawer. */
  prepare?: (page: Page) => Promise<void>;
  /** What sits nearest the corner, to see that it stays put outside the desktop. */
  corner: string[];
};

async function openDuetMenu(page: Page) {
  await page.getByRole("button", { name: "Menu" }).click();
  await page.getByRole("navigation", { name: "Menu" }).waitFor();
  await page.getByText("Renewal for the studio policy").waitFor();
}

const CASES: Case[] = [
  {
    name: "openduet-menu",
    skin: "openduet",
    path: "/",
    width: DEFAULT_WIDTH,
    prepare: openDuetMenu,
    corner: ['[data-slot="sheet-title"]'],
  },
  {
    name: "openduet-chat",
    skin: "openduet",
    path: "/",
    width: NARROWEST_WIDTH,
    corner: ['button[aria-label="Menu"]'],
  },
  {
    name: "openduet-page",
    skin: "openduet",
    path: "/bots",
    width: DEFAULT_WIDTH,
    corner: [
      'button[aria-label="Back to Home"]',
      "[data-openduet-page] header p",
    ],
  },
  {
    name: "openduet-pane",
    skin: "openduet",
    path: "/channel/c-1?watch=true",
    width: NARROWEST_WIDTH,
    corner: ['button[aria-label="Menu"]'],
  },
  {
    name: "openduet-update",
    skin: "openduet",
    path: "/",
    width: DEFAULT_WIDTH,
    update: true,
    corner: ['[aria-label="OpenBot update"] p'],
  },
  {
    name: "opendots",
    skin: "opendots",
    path: "/",
    width: DEFAULT_WIDTH,
    corner: [
      'nav[aria-label="Workspace navigation"] a',
      '[data-testid="opendots-wordmark"]',
    ],
  },
  {
    name: "opendots-sidebar-hidden",
    skin: "opendots",
    path: "/",
    width: DEFAULT_WIDTH,
    prepare: async (page) => {
      await page.getByRole("button", { name: "Hide navigation" }).click();
      await page.getByRole("button", { name: "Show navigation" }).waitFor();
    },
    corner: ['button[aria-label="Show navigation"]'],
  },
  {
    name: "opendots-narrowest",
    skin: "opendots",
    path: "/",
    width: NARROWEST_WIDTH,
    corner: [
      'button[aria-label="Open navigation"]',
      'nav[aria-label="Breadcrumb"]',
    ],
  },
  {
    name: "opendots-narrowest-drawer",
    skin: "opendots",
    path: "/",
    width: NARROWEST_WIDTH,
    prepare: async (page) => {
      await page.getByRole("button", { name: "Open navigation" }).click();
      await page.locator('[data-testid="opendots-wordmark"]').waitFor();
    },
    corner: ['[data-testid="opendots-wordmark"]'],
  },
  {
    name: "openfuse-narrowest",
    skin: "openfuse",
    path: "/",
    width: NARROWEST_WIDTH,
    corner: ['button[aria-label="Open conversations and menu"]'],
  },
  {
    name: "openfuse-update",
    skin: "openfuse",
    path: "/",
    width: NARROWEST_WIDTH,
    update: true,
    corner: ['[aria-label="OpenBot update"] p'],
  },
];

async function bundle(): Promise<string> {
  const built = await Bun.build({
    entrypoints: [join(import.meta.dir, "skins-window-buttons.fixture.tsx")],
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

type Compiler = Awaited<ReturnType<typeof compile>>;
let compiler: Compiler;

/** The app's stylesheet, built by Tailwind for these classes, as the app's build does. */
async function stylesheet(classes: string[]): Promise<string> {
  if (!compiler) {
    const tailwind = dirname(Bun.resolveSync("tailwindcss/package.json", APP));
    const entry = join(APP, "src", "styles.css");
    compiler = await compile(readFileSync(entry, "utf8"), {
      base: dirname(entry),
      loadStylesheet: async (id, base) => {
        const path =
          id === "tailwindcss"
            ? join(tailwind, "index.css")
            : id.startsWith(".")
              ? join(base, id)
              : packageStylesheet(id);
        return {
          path,
          base: dirname(path),
          content: readFileSync(path, "utf8"),
        };
      },
    });
  }
  return compiler.build(classes);
}

let browser: Browser;
let script: string;

beforeAll(async () => {
  if (!asked) return;
  script = await bundle();
  const { chromium } = await import("playwright-core");
  // The CI job installs full Chromium without the headless shell.
  browser = await chromium.launch({ channel: "chromium" });
});

afterAll(async () => {
  await browser?.close();
});

/** The case's frame, styled, in a window marked as the macOS desktop marks it, or not. */
async function open(
  shown: Case,
  macDesktop: boolean,
  theme: "light" | "dark" = "light",
): Promise<Page> {
  const page = await browser.newPage({
    viewport: { width: shown.width, height: 800 },
    deviceScaleFactor: 2,
  });
  page.on("pageerror", (error) => console.error(error));
  const inter = join(packageDir("@fontsource-variable/inter"), "files");
  const mark = macDesktop ? ' data-desktop-titlebar="overlay"' : "";
  await page.route(`${ORIGIN}/**`, (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/")
      return route.fulfill({
        contentType: "text/html",
        body: `<!doctype html><html lang="en" class="${theme}" data-skin="${shown.skin}"${mark}><head><meta charset="utf-8"><script>localStorage.setItem("openbot-skin", "${shown.skin}")</script></head><body><div id="root"></div><script type="module" src="/frame.js"></script></body></html>`,
      });
    if (path === "/frame.js")
      return route.fulfill({ contentType: "text/javascript", body: script });
    const font = join(inter, path.split("/").pop() ?? "");
    if (path.startsWith("/files/") && existsSync(font))
      return route.fulfill({ path: font });
    return route.fulfill({ status: 404 });
  });
  const query = new URLSearchParams({ skin: shown.skin, path: shown.path });
  if (shown.update) query.set("update", "1");
  await page.goto(`${ORIGIN}/?${query}`);
  await page.locator("[data-page]").waitFor();
  if (shown.update)
    await page.locator('[aria-label="OpenBot update"]').waitFor();
  await shown.prepare?.(page);
  const classes = await page.evaluate(() => [
    ...new Set(
      [...document.querySelectorAll("[class]")].flatMap((element) => [
        ...element.classList,
      ]),
    ),
  ]);
  await page.addStyleTag({ content: await stylesheet(classes) });
  await page.evaluate(() => document.fonts.ready);
  return page;
}

/**
 * What the window's buttons would cover: every control, picture and run of text drawn in their
 * area, named by its accessible name or its words.
 */
async function covered(page: Page): Promise<string[]> {
  return page.evaluate((area) => {
    const hits = (rect: DOMRect) =>
      rect.width > 0 &&
      rect.height > 0 &&
      rect.left < area.right &&
      rect.right > area.left &&
      rect.top < area.bottom &&
      rect.bottom > area.top;
    const seen = (element: Element) => {
      const style = getComputedStyle(element);
      return (
        style.visibility !== "hidden" &&
        Number(style.opacity) > 0 &&
        element.closest("[hidden], [aria-hidden=true][inert]") === null
      );
    };
    const found: string[] = [];
    for (const element of document.querySelectorAll(
      "a, button, [role=button], svg, img, input, textarea",
    )) {
      if (!seen(element) || !hits(element.getBoundingClientRect())) continue;
      found.push(
        `${element.tagName.toLowerCase()} ${element.getAttribute("aria-label") ?? element.textContent?.trim() ?? ""}`,
      );
    }
    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT,
    );
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const words = node.textContent?.trim();
      const parent = node.parentElement;
      if (!words || !parent || !seen(parent)) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      if ([...range.getClientRects()].some(hits)) found.push(`text ${words}`);
    }
    return found;
  }, WINDOW_BUTTONS);
}

/** Where each of the case's corner pieces starts, rounded to the pixel. */
async function corner(page: Page, shown: Case) {
  const found: Record<string, { x: number; y: number } | null> = {};
  for (const selector of shown.corner) {
    const box = await page.locator(selector).first().boundingBox();
    found[selector] = box && { x: Math.round(box.x), y: Math.round(box.y) };
  }
  return found;
}

describe.skipIf(!asked)("the skins and the window's buttons", () => {
  for (const shown of CASES) {
    test(`${shown.name} at ${shown.width}px: in the macOS desktop, nothing is drawn under the window's buttons`, async () => {
      const page = await open(shown, true);
      try {
        expect(await covered(page)).toEqual([]);
      } finally {
        await page.close();
      }
    }, 30_000);
  }

  test("OpenDuet's menu drawer starts its header below the window's buttons in the macOS desktop", async () => {
    const page = await open(CASES[0] as Case, true);
    try {
      const inset = await page.$eval(
        '[data-slot="sheet-header"]',
        (header) => getComputedStyle(header).paddingTop,
      );
      expect(inset).toBe("48px");
    } finally {
      await page.close();
    }
  }, 30_000);

  test("without the mark, on Windows or in a browser, the drawer's header keeps its usual inset", async () => {
    const page = await open(CASES[0] as Case, false);
    try {
      const inset = await page.$eval(
        '[data-slot="sheet-header"]',
        (header) => getComputedStyle(header).paddingTop,
      );
      expect(inset).toBe("20px");
    } finally {
      await page.close();
    }
  }, 30_000);

  test("without the mark, every skin's corner is where it has always been", async () => {
    // Measured on main before the desktop's room was made, so a skin that moves outside it fails.
    const before = {
      "openduet-menu": { '[data-slot="sheet-title"]': { x: 20, y: 20 } },
      "openduet-chat": { 'button[aria-label="Menu"]': { x: 161, y: 20 } },
      "openduet-page": {
        'button[aria-label="Back to Home"]': { x: 16, y: 12 },
        "[data-openduet-page] header p": { x: 484, y: 25 },
      },
      "openduet-pane": { 'button[aria-label="Menu"]': { x: 16, y: 20 } },
      "openduet-update": {
        '[aria-label="OpenBot update"] p': { x: 16, y: 11 },
      },
      opendots: {
        'nav[aria-label="Workspace navigation"] a': { x: 6, y: 16 },
        '[data-testid="opendots-wordmark"]': { x: 60, y: 23 },
      },
      "opendots-sidebar-hidden": {
        'button[aria-label="Show navigation"]': { x: 70, y: 12 },
      },
      "opendots-narrowest": {
        'button[aria-label="Open navigation"]': { x: 10, y: 14 },
        'nav[aria-label="Breadcrumb"]': { x: 48, y: 22 },
      },
      "opendots-narrowest-drawer": {
        '[data-testid="opendots-wordmark"]': { x: 12, y: 23 },
      },
      "openfuse-narrowest": {
        'button[aria-label="Open conversations and menu"]': { x: 20, y: 16 },
      },
      "openfuse-update": {
        '[aria-label="OpenBot update"] p': { x: 16, y: 11 },
      },
    };
    const seen: Record<string, Awaited<ReturnType<typeof corner>>> = {};
    for (const shown of CASES) {
      const page = await open(shown, false);
      try {
        seen[shown.name] = await corner(page, shown);
      } finally {
        await page.close();
      }
    }
    expect(seen).toEqual(before);
  }, 60_000);

  test.skipIf(!shots)(
    "screenshots of each corner",
    async () => {
      if (!shots) return;
      mkdirSync(shots, { recursive: true });
      for (const shown of CASES) {
        for (const theme of ["light", "dark"] as const) {
          const page = await open(shown, true, theme);
          try {
            // The buttons' area, outlined, since a browser draws no window buttons of its own.
            await page.evaluate((area) => {
              const box = document.createElement("div");
              Object.assign(box.style, {
                position: "fixed",
                left: `${area.left}px`,
                top: `${area.top}px`,
                width: `${area.right - area.left}px`,
                height: `${area.bottom - area.top}px`,
                outline: "1px dashed #e5484d",
                background: "rgb(229 72 77 / 0.18)",
                zIndex: "2147483647",
                pointerEvents: "none",
              });
              document.body.append(box);
            }, WINDOW_BUTTONS);
            await page.screenshot({
              path: join(
                shots,
                `skins-window-buttons-${shown.name}-${theme}.png`,
              ),
              clip: { x: 0, y: 0, width: 420, height: 200 },
            });
          } finally {
            await page.close();
          }
        }
      }
    },
    120_000,
  );
});
