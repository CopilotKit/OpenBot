import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Browser, BrowserType, Page } from "playwright-core";
import { compile } from "tailwindcss";
import { personBody } from "./accounts-api";

/**
 * The sidebar's edge narrows the sidebar well past where it used to stop, and the sidebar never
 * takes most of the window, at any zoom.
 *
 * Reported from OpenBot Desktop on a Mac: "Cannot drag sidebar to make it smaller. This is
 * especially painful when you need to zoom in to read the text because zooming in zooms the entire
 * screen instead of just the text so the sidebar gets proportionally larger", and then "it stops way
 * too wide" and, zoomed in to read, "the sidebar takes up half the screen and i can't make it any
 * smaller". Two causes. The floor was high: 220px for a panel (268px beside the strip), and a
 * footer's widest button measured into it raised it further. And zooming a window in makes it fewer
 * of the page's pixels wide while the sidebar kept its count of them: a width dragged out to 480px
 * at 100% was 480px of a window zoomed to 175% (about 820 of the page's pixels), well over half of
 * it. The floor is now 180px a panel, and the sidebar is held to two-fifths of the window, the
 * remembered width coming back whole once the window is wide again. Not 160px, which it was for a
 * day: there the panel's own heading read "Conversat…" and "No conversations yet" took three lines,
 * a word a line. At the floor every heading is read whole, in the real panels and sidebars.
 *
 * Rendered in a real browser, because the width is the browser's to resolve (a CSS `clamp` against
 * the window's width) and the drag is real pointer events on the edge. The sidebars are the shells'
 * own (`SidebarShell`, `Sidebar`, `SidebarRail`), with the app's stylesheet: the app's, a strip of
 * sections beside a panel, and Admin's and Settings', one panel. A zoomed-in window is a viewport of
 * as many CSS pixels as a 1440pt window zoomed to 175% has.
 *
 *   OPENBOT_APP_BROWSER=1 OPENBOT_APP_ENGINES=chromium,webkit bun test app/tests/sidebar-zoom-drag.test.tsx
 *
 * Chromium always, WebKit too (the engine OpenBot Desktop's Mac window draws with) when
 * `OPENBOT_APP_ENGINES` names it. With OPENBOT_APP_SHOTS=<dir> it saves each case as
 * sidebar-zoom-<engine>-<shape>-<case>.png.
 */
const asked = process.env.OPENBOT_APP_BROWSER === "1";
const shots = process.env.OPENBOT_APP_SHOTS;

const APP = join(import.meta.dir, "..");
const ORIGIN = "http://openbot.test";

/** A 1440pt window at 100%, and zoomed to 175%. */
const WIDE = { width: 1440, height: 900 };
const ZOOMED = { width: 820, height: 540 };
/** Two-fifths of the zoomed window: `SIDEBAR_MAX_SHARE` in app/src/lib/sidebar.ts. */
const ZOOMED_MOST = Math.floor(ZOOMED.width * 0.4);

/**
 * The narrowest each shape may be dragged: the panel's floor, plus the 3rem strip beside one; and
 * where a drag stopped before (`was`), which it now goes well past.
 */
const SHAPES = [
  { name: "app", strip: true, floor: 180 + 48, was: 220 + 48 },
  { name: "admin-settings", strip: false, floor: 180, was: 220 },
] as const;
type Shape = (typeof SHAPES)[number];

/**
 * The real sidebars, each in its shape: the app's Conversations and Bots panels beside the strip,
 * and Settings' and Admin's own. `names` are their headings, so a test that finds nothing cut short
 * knows it looked at every one of them.
 */
const SCREENS = [
  { screen: "conversations", shape: SHAPES[0], names: ["Conversations"] },
  { screen: "bots", shape: SHAPES[0], names: ["Bots"] },
  {
    screen: "settings",
    shape: SHAPES[1],
    names: ["You", "Every Bot", "OpenBot"],
  },
  {
    screen: "admin",
    shape: SHAPES[1],
    names: [
      "Routines",
      "Skills",
      "Apps",
      "Computer",
      "Approvals",
      "Activity",
      "Vault",
      "Organization",
    ],
  },
] as const;
type Screen = (typeof SCREENS)[number]["screen"];

const ORGANIZATION = "/api/v2/organizations/default";

/** What the server answers these sidebars: an admin of a company's own OpenBot, no conversations. */
function answer(path: string): unknown {
  switch (path) {
    case `${ORGANIZATION}/conversations`:
      return { conversations: [], nextCursor: null };
    case `${ORGANIZATION}/bots`:
      return {
        bots: ["Research", "Invoice Review"].map((name) => ({
          id: name.toLowerCase().replace(" ", "-"),
          name,
          title: "",
          roleDescription: "",
          avatarSeed: name,
          lastConversationAt: null,
        })),
        nextCursor: null,
      };
    case `${ORGANIZATION}/people/me/bot-attention`:
      return { attention: [], lastPingId: null, nextCursor: null };
    case `${ORGANIZATION}/people/me`:
      return {
        person: personBody({
          id: "dana",
          name: "Dana Whitfield",
          email: "dana@example.com",
          role: "admin",
        }),
        openbotVersion: "v1.1.0",
      };
    case `${ORGANIZATION}/deployment`:
      return {
        generativeUi: true,
        selfHostBanner: false,
        localEvaluation: false,
        edition: "team",
        authProviders: [],
        ssoConfigured: false,
        ssoRequired: false,
      };
    case "/api/v2/people/me/organizations":
      return {
        organizations: [
          {
            id: "default",
            slug: "default",
            name: "Acme Freight",
            role: "admin",
            personal: false,
            active: true,
          },
        ],
        canCreate: true,
        nextCursor: null,
      };
    case `${ORGANIZATION}/management`:
      return { state: "not-connected", agentInstalledByChart: true };
    default:
      return undefined;
  }
}

/**
 * Every heading the sidebar draws, the open panel's title and each group's label, with what it
 * needs and what it has: cut short is wider than the box it is drawn in.
 */
async function headings(page: Page) {
  return page.evaluate(() =>
    [
      ...document.querySelectorAll<HTMLElement>(
        '[data-slot="section-panel"]:not([hidden]) h2, [data-sidebar="group-label"]',
      ),
    ]
      .filter((element) => element.getClientRects().length > 0)
      .map((element) => ({
        text: element.textContent?.trim() ?? "",
        needs: element.scrollWidth,
        has: element.clientWidth,
      })),
  );
}

/** How many lines the element reading exactly `text` is drawn on. */
async function lines(page: Page, text: string) {
  return page.evaluate((text) => {
    const element = [...document.querySelectorAll("*")].find(
      (one) => one.childElementCount === 0 && one.textContent === text,
    );
    if (!element) return 0;
    const range = document.createRange();
    range.selectNodeContents(element);
    return new Set(
      [...range.getClientRects()].map((rect) => Math.round(rect.top)),
    ).size;
  }, text);
}

async function bundle(): Promise<string> {
  const built = await Bun.build({
    entrypoints: [join(import.meta.dir, "sidebar-zoom-drag.fixture.tsx")],
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

let script: string;
let css: string;
const engines: [string, Browser][] = [];

beforeAll(async () => {
  if (!asked) return;
  script = await bundle();
  // Every class the sidebar and its shells can draw, read from their source.
  const sources = [
    ...["ui", "layout", "app-sidebar"].flatMap((dir) =>
      readdirSync(join(APP, "src", "components", dir))
        .filter((file) => file.endsWith(".tsx"))
        .map((file) => `components/${dir}/${file}`),
    ),
    "components/admin/admin-sidebar.tsx",
    "components/settings/settings-sidebar.tsx",
    "components/agents/bot-orb.tsx",
    "../tests/sidebar-zoom-drag.fixture.tsx",
  ].flatMap((file) =>
    readFileSync(join(APP, "src", file), "utf8").split(/[\s"'`]+/),
  );
  css = await stylesheet([...new Set(sources)].sort());
  const { chromium, webkit } = await import("playwright-core");
  // The CI job installs full Chromium without the headless shell.
  engines.push(["chromium", await chromium.launch({ channel: "chromium" })]);
  if ((process.env.OPENBOT_APP_ENGINES ?? "").includes("webkit"))
    engines.push(["webkit", await (webkit as BrowserType).launch()]);
});

afterAll(async () => {
  for (const [, browser] of engines) await browser.close();
});

/** The shape's sidebar in a window `size` big, with nothing remembered yet. */
async function open(
  browser: Browser,
  shape: Shape,
  size: { width: number; height: number },
  screen?: Screen,
): Promise<Page> {
  const page = await browser.newPage({ viewport: size, deviceScaleFactor: 2 });
  page.on("pageerror", (error) => console.error(error));
  const inter = join(packageDir("@fontsource-variable/inter"), "files");
  await page.route(`${ORIGIN}/**`, (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/")
      return route.fulfill({
        contentType: "text/html",
        body: `<!doctype html><html lang="en"><head><meta charset="utf-8"><style>${css}</style></head><body class="bg-background text-foreground"><div id="root"></div><script type="module" src="/shell.js"></script></body></html>`,
      });
    if (path === "/shell.js")
      return route.fulfill({ contentType: "text/javascript", body: script });
    // The app's own typeface, so a heading is as wide here as it is in the app.
    const font = join(inter, path.split("/").pop() ?? "");
    if (path.startsWith("/files/") && existsSync(font))
      return route.fulfill({ path: font });
    if (path.startsWith("/api/")) {
      const json = answer(path);
      return json === undefined
        ? route.fulfill({ status: 404, json: { detail: "Not found." } })
        : route.fulfill({ json });
    }
    return route.fulfill({ status: 404 });
  });
  const search = new URLSearchParams();
  if (shape.strip) search.set("strip", "1");
  if (screen) search.set("screen", screen);
  await page.goto(`${ORIGIN}/${search.size ? `?${search}` : ""}`);
  await page.locator('[data-slot="sidebar-rail"]').waitFor();
  await page.evaluate(() => document.fonts.ready);
  return page;
}

/** The sidebar's drawn width, the window's, and the width remembered for next time. */
async function measured(page: Page) {
  return page.evaluate(() => {
    const container = document.querySelector(
      '[data-slot="sidebar-container"]',
    ) as HTMLElement;
    return {
      width: Math.round(container.getBoundingClientRect().width),
      window: window.innerWidth,
      stored: window.localStorage.getItem("openbot-sidebar-width"),
    };
  });
}

/** The sidebar's edge pressed, dragged `by` pixels in steps as a hand does, and let go. */
async function drag(page: Page, by: number) {
  const rail = page.locator('[data-slot="sidebar-rail"]');
  expect(await rail.isVisible()).toBe(true);
  const box = await rail.boundingBox();
  if (!box) throw new Error("the sidebar's edge has no box");
  // Its half over the sidebar: the app's sidebar clips what lies past its own edge.
  const x = box.x + box.width / 4;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + by / 2, y, { steps: 6 });
  await page.mouse.move(x + by, y, { steps: 6 });
  await page.mouse.up();
}

async function shot(page: Page, name: string) {
  if (!shots) return;
  mkdirSync(shots, { recursive: true });
  await page.screenshot({
    path: join(shots, `sidebar-zoom-${name}.png`),
    animations: "disabled",
  });
}

describe.skipIf(!asked)("the sidebar's edge at any zoom", () => {
  for (const shape of SHAPES) {
    test(`${shape.name}: zoomed in, the sidebar is at most two-fifths of the window and drags down to its floor`, async () => {
      for (const [engine, browser] of engines) {
        const page = await open(browser, shape, ZOOMED);
        try {
          // 340px by default, which is more than two-fifths of the zoomed window.
          expect(await measured(page)).toMatchObject({
            width: ZOOMED_MOST,
            window: ZOOMED.width,
          });
          await shot(page, `${engine}-${shape.name}-zoomed`);

          await drag(page, -400);
          const narrowed = await measured(page);
          expect(narrowed).toEqual({
            width: shape.floor,
            window: ZOOMED.width,
            stored: String(shape.floor),
          });
          // Well under half the zoomed window, and past where the drag used to stop.
          expect(narrowed.width / narrowed.window).toBeLessThan(0.3);
          expect(narrowed.width).toBeLessThanOrEqual(shape.was - 40);
          await shot(page, `${engine}-${shape.name}-zoomed-narrowed`);

          // Out again as far as it goes: two-fifths of the window, not the 480px of a wide one.
          await drag(page, 600);
          expect(await measured(page)).toEqual({
            width: ZOOMED_MOST,
            window: ZOOMED.width,
            stored: String(ZOOMED_MOST),
          });
          await shot(page, `${engine}-${shape.name}-zoomed-widened`);
        } finally {
          await page.close();
        }
      }
    }, 120_000);

    test(`${shape.name}: a width dragged wide at 100% is held to two-fifths zoomed in, and comes back zoomed out`, async () => {
      for (const [engine, browser] of engines) {
        const page = await open(browser, shape, WIDE);
        try {
          await drag(page, 600);
          expect(await measured(page)).toEqual({
            width: 480,
            window: WIDE.width,
            stored: "480",
          });
          await shot(page, `${engine}-${shape.name}-wide-widened`);

          // Zoomed in: the window is fewer of the page's pixels wide.
          await page.setViewportSize(ZOOMED);
          await page.reload();
          await page.locator('[data-slot="sidebar-rail"]').waitFor();
          expect(await measured(page)).toEqual({
            width: ZOOMED_MOST,
            window: ZOOMED.width,
            stored: "480",
          });
          await shot(page, `${engine}-${shape.name}-widened-then-zoomed`);

          // And narrows from there, from what is drawn rather than from what was remembered.
          await drag(page, -40);
          expect(await measured(page)).toEqual({
            width: ZOOMED_MOST - 40,
            window: ZOOMED.width,
            stored: String(ZOOMED_MOST - 40),
          });

          await page.setViewportSize(WIDE);
          await drag(page, 600);
          expect(await measured(page)).toMatchObject({ width: 480 });
        } finally {
          await page.close();
        }
      }
    }, 120_000);

    /*
     * "It stops way too wide": at 100% on a large screen, a drag goes past the old floor down to the
     * new one, and the next page drawn starts at that width.
     */
    test(`${shape.name}: at 100%, the edge drags past where it used to stop`, async () => {
      for (const [engine, browser] of engines) {
        const page = await open(browser, shape, WIDE);
        try {
          await drag(page, -600);
          expect(await measured(page)).toEqual({
            width: shape.floor,
            window: WIDE.width,
            stored: String(shape.floor),
          });
          await page.reload();
          await page.locator('[data-slot="sidebar-rail"]').waitFor();
          expect(await measured(page)).toMatchObject({ width: shape.floor });
          await shot(page, `${engine}-${shape.name}-wide-narrowed`);
        } finally {
          await page.close();
        }
      }
    }, 120_000);

    /*
     * The sidebar sits beside the page from 768px, and is a sheet over it below. Wherever it sits
     * beside the page, its edge is there to drag.
     */
    test(`${shape.name}: the edge is there to drag at the narrowest window the sidebar sits beside the page in`, async () => {
      for (const [, browser] of engines) {
        const page = await open(browser, shape, { width: 768, height: 540 });
        try {
          expect(await measured(page)).toMatchObject({ width: 307 });
          await drag(page, -400);
          expect(await measured(page)).toMatchObject({ width: shape.floor });
        } finally {
          await page.close();
        }
      }
    }, 120_000);
  }

  /*
   * As narrow as it goes, the sidebar is still read: Conversations and Bots over their panels, and
   * every group and entry in Settings and Admin, whole, never "Conversat…".
   */
  for (const { screen, shape, names } of SCREENS) {
    test(`${screen}: at its floor, every heading in the sidebar is whole`, async () => {
      for (const [engine, browser] of engines) {
        const page = await open(browser, shape, ZOOMED, screen);
        try {
          await page.getByText(names[0], { exact: true }).first().waitFor();
          await drag(page, -400);
          expect(await measured(page)).toMatchObject({ width: shape.floor });
          const drawn = await headings(page);
          expect(drawn.map((heading) => heading.text)).toEqual([...names]);
          expect(
            drawn.filter((heading) => heading.needs > heading.has),
          ).toEqual([]);
          // A roster nobody has used yet says so on one line, not "No / conversations / yet".
          if (screen === "conversations")
            expect(await lines(page, "No conversations yet")).toBe(1);
          await shot(page, `${engine}-${screen}-floor`);
        } finally {
          await page.close();
        }
      }
    }, 120_000);
  }
});
