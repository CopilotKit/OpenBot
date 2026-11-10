import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Browser, Page } from "playwright-core";
import { compile } from "tailwindcss";

/**
 * The page under the update banner holds still while the new version gets ready.
 *
 * Seen on Windows at OpenBot Desktop's default window width: "OpenBot 1.0.1 is available." with
 * Update and restart sat on one line, and when the background download started the banner wrapped
 * to two lines and pushed the page down; it moved again when the version was ready. The banner is
 * now one line in every state: a sentence short enough for the column at the default width, cut
 * short with the whole of it on hover when a long internal version needs more.
 *
 * Rendered in a real Chromium, because where a line wraps is the browser's layout to decide. The
 * banner is the real component with the app's stylesheet; only the desktop app's answer is
 * scripted, moving through the states the shell reports.
 *
 *   OPENBOT_APP_BROWSER=1 bun test app/tests/update-banner-layout.test.tsx
 *
 * With OPENBOT_APP_SHOTS=<dir> it also saves the banner in each state at the default width, light
 * and dark, as update-banner-<state>-<theme>.png.
 */
const asked = process.env.OPENBOT_APP_BROWSER === "1";
const shots = process.env.OPENBOT_APP_SHOTS;

const APP = join(import.meta.dir, "..");
const ORIGIN = "http://openbot.test";

/**
 * The content column's width: at the default 1000px window, less the 340px sidebar and the panel's
 * inset (measured on Windows, D50), and at the 720px narrowest window the app allows.
 */
const DEFAULT_WIDTH = 650;
const NARROWEST_WIDTH = 370;

const RELEASE = "1.0.1";
/** As an internal build names itself, the longest version a banner shows. */
const INTERNAL = "1.0.1-internal.1008.g6e5f485bc71c";

type Offer = {
  version: string | null;
  current: string;
  installing: { downloaded: number; total: number; restarting: boolean } | null;
  updatesItself: boolean;
  ready:
    | { state: "preparing"; done: number; total: number }
    | { state: "ready" }
    | null;
};

/** The states the shell reports, in the order a person sees them, and words that say each one. */
function states(
  version: string,
): { name: string; offer: Offer; says: string }[] {
  const offer = (ready: Offer["ready"]): Offer => ({
    version,
    current: "1.0.0",
    installing: null,
    updatesItself: true,
    ready,
  });
  return [
    { name: "available", offer: offer(null), says: "is available" },
    {
      name: "downloading",
      offer: offer({ state: "preparing", done: 40, total: 100 }),
      says: "(40%)",
    },
    {
      name: "almost",
      offer: offer({ state: "preparing", done: 99, total: 100 }),
      says: "(99%)",
    },
    {
      name: "ready",
      offer: offer({ state: "ready" }),
      says: "ready to install",
    },
    // After Update and restart: the buttons give way to how far the app's own download is.
    {
      name: "installing",
      offer: {
        ...offer({ state: "ready" }),
        installing: { downloaded: 50, total: 200, restarting: false },
      },
      says: "Downloading… 25%",
    },
  ];
}

async function bundle(): Promise<string> {
  const built = await Bun.build({
    entrypoints: [join(import.meta.dir, "update-banner-layout.fixture.tsx")],
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
/** The classes every state's banner wears, gathered once so one stylesheet styles them all. */
let css: string;

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

/** The banner's page at `width`, styled, showing nothing yet. */
async function open(
  width: number,
  theme: "light" | "dark" = "light",
): Promise<Page> {
  const page = await browser.newPage({
    viewport: { width: Math.max(width, 400), height: 300 },
    deviceScaleFactor: 2,
  });
  page.on("pageerror", (error) => console.error(error));
  const inter = join(packageDir("@fontsource-variable/inter"), "files");
  await page.route(`${ORIGIN}/**`, (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/")
      return route.fulfill({
        contentType: "text/html",
        body: `<!doctype html><html lang="en" class="${theme}"><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module" src="/banner.js"></script></body></html>`,
      });
    if (path === "/banner.js")
      return route.fulfill({ contentType: "text/javascript", body: script });
    const font = join(inter, path.split("/").pop() ?? "");
    if (path.startsWith("/files/") && existsSync(font))
      return route.fulfill({ path: font });
    return route.fulfill({ status: 404 });
  });
  await page.goto(`${ORIGIN}/?width=${width}`);
  await page.locator("[data-below]").waitFor();
  if (!css) {
    // Every state once, so the stylesheet has each one's classes.
    const classes = new Set<string>();
    for (const state of [...states(RELEASE), ...states(INTERNAL)]) {
      await show(page, state.offer, state.says);
      for (const name of await page.evaluate(() =>
        [...document.querySelectorAll("[class]")].flatMap((element) => [
          ...element.classList,
        ]),
      ))
        classes.add(name);
    }
    css = await stylesheet([...classes]);
  }
  await page.addStyleTag({ content: css });
  await page.evaluate(() => document.fonts.ready);
  return page;
}

/** Have the banner show `offer`, and wait until it says it. */
async function show(page: Page, offer: Offer, says: string) {
  await page.evaluate(
    (next) =>
      (window as unknown as { __show(offer: unknown): Promise<void> }).__show(
        next,
      ),
    offer,
  );
  await page.waitForFunction(
    (words) =>
      document
        .querySelector('[aria-label="OpenBot update"]')
        ?.textContent?.includes(words) ?? false,
    says,
  );
}

/** Where the page under the banner starts, and the banner's height. */
async function measured(page: Page) {
  return page.evaluate(() => ({
    below: Math.round(
      document.querySelector("[data-below]")?.getBoundingClientRect().top ?? -1,
    ),
    banner: Math.round(
      document
        .querySelector('[aria-label="OpenBot update"]')
        ?.getBoundingClientRect().height ?? -1,
    ),
  }));
}

describe.skipIf(!asked)("the update banner's height", () => {
  for (const [label, width] of [
    ["the default window", DEFAULT_WIDTH],
    ["the narrowest window", NARROWEST_WIDTH],
  ] as const) {
    for (const version of [RELEASE, INTERNAL]) {
      test(`at ${label}, ${version}: the page below holds still from available to ready`, async () => {
        const page = await open(width);
        try {
          const seen: Record<string, { below: number; banner: number }> = {};
          for (const state of states(version)) {
            await show(page, state.offer, state.says);
            seen[state.name] = await measured(page);
          }
          const first = seen.available;
          expect(first.below).toBeGreaterThan(0);
          for (const [name, where] of Object.entries(seen))
            expect({ state: name, ...where }).toEqual({
              state: name,
              ...first,
            });
        } finally {
          await page.close();
        }
      }, 60_000);
    }
  }

  test("at the default window, a release's sentence fits whole in every state", async () => {
    const page = await open(DEFAULT_WIDTH);
    try {
      for (const state of states(RELEASE)) {
        await show(page, state.offer, state.says);
        const cut = await page.evaluate(() => {
          const said = document.querySelector(
            '[aria-label="OpenBot update"] p',
          ) as HTMLElement | null;
          return said ? said.scrollWidth > said.clientWidth : true;
        });
        expect({ state: state.name, cut }).toEqual({
          state: state.name,
          cut: false,
        });
      }
    } finally {
      await page.close();
    }
  }, 60_000);

  test.skipIf(!shots)(
    "screenshots at the default window",
    async () => {
      if (!shots) return;
      mkdirSync(shots, { recursive: true });
      for (const theme of ["light", "dark"] as const) {
        const page = await open(DEFAULT_WIDTH, theme);
        try {
          for (const version of [RELEASE, INTERNAL]) {
            for (const state of states(version)) {
              await show(page, state.offer, state.says);
              const height = (await measured(page)).below + 48;
              await page.screenshot({
                path: join(
                  shots,
                  `update-banner-${version === RELEASE ? "release" : "internal"}-${state.name}-${theme}.png`,
                ),
                clip: { x: 0, y: 0, width: DEFAULT_WIDTH, height },
              });
            }
          }
        } finally {
          await page.close();
        }
      }
    },
    120_000,
  );
});
