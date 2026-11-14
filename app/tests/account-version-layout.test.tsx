import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Browser, Page } from "playwright-core";
import { compile } from "tailwindcss";

/**
 * The version in the sidebar's account row reads whole.
 *
 * Seen on a Windows update test: the row read "Fresh Clone   main-2…". The name and the version
 * shared the row 4 to 1, and the version was cut short to fit its fifth, which a release's "v1.0.2"
 * fits and a build's "main-20261113-9", "test-20261113-4" or "internal-6e5f485bc71c" does not. The
 * version is now as wide as its words, and the name gives way.
 *
 * Rendered in a real Chromium, because where text is cut is the browser's layout to decide. The row
 * is the real component in the real sidebar parts with the app's stylesheet, at the sidebar's width
 * before anybody drags it (340px) and at the narrowest it can be dragged to (220px).
 *
 *   OPENBOT_APP_BROWSER=1 bun test app/tests/account-version-layout.test.tsx
 *
 * With OPENBOT_APP_SHOTS=<dir> it also saves the row with a build's and a release's version at each
 * width, as account-version-<build|release>-<width>.png.
 */
const asked = process.env.OPENBOT_APP_BROWSER === "1";
const shots = process.env.OPENBOT_APP_SHOTS;

const APP = join(import.meta.dir, "..");
const ORIGIN = "http://openbot.test";

/** `SIDEBAR_WIDTH` and `SIDEBAR_MIN_WIDTH` in app/src/lib/sidebar.ts. */
const WIDTHS = [340, 220] as const;
const LONG_NAME = "Alexandria Montgomery-Fitzwilliam";
const BUILDS = ["main-20261113-9", "test-20261113-14", "internal-6e5f485bc71c"];
const RELEASE = "v1.0.2";

async function bundle(): Promise<string> {
  const built = await Bun.build({
    entrypoints: [join(import.meta.dir, "account-version-layout.fixture.tsx")],
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
  const { chromium } = await import("playwright-core");
  // The CI job installs full Chromium without the headless shell.
  browser = await chromium.launch({ channel: "chromium" });
});

afterAll(async () => {
  await browser?.close();
});

/** The row in a sidebar `width` wide, styled, for `name` on a server at `version`. */
async function open(
  width: number,
  name: string,
  version: string,
): Promise<Page> {
  const page = await browser.newPage({
    viewport: { width: 600, height: 200 },
    deviceScaleFactor: 2,
  });
  page.on("pageerror", (error) => console.error(error));
  const inter = join(packageDir("@fontsource-variable/inter"), "files");
  await page.route(`${ORIGIN}/**`, (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/")
      return route.fulfill({
        contentType: "text/html",
        body: `<!doctype html><html lang="en" class="light"><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module" src="/row.js"></script></body></html>`,
      });
    if (path === "/row.js")
      return route.fulfill({ contentType: "text/javascript", body: script });
    const font = join(inter, path.split("/").pop() ?? "");
    if (path.startsWith("/files/") && existsSync(font))
      return route.fulfill({ path: font });
    return route.fulfill({ status: 404 });
  });
  const query = new URLSearchParams({
    width: String(width),
    name,
    version,
  });
  await page.goto(`${ORIGIN}/?${query}`);
  await page.locator('[data-slot="openbot-version"]').waitFor();
  if (!css) {
    const classes = await page.evaluate(() =>
      [...document.querySelectorAll("[class]")].flatMap((element) => [
        ...element.classList,
      ]),
    );
    css = await stylesheet([...new Set(classes)]);
  }
  await page.addStyleTag({ content: css });
  await page.evaluate(() => document.fonts.ready);
  return page;
}

/** How the version and the name sit in the row. */
async function measured(page: Page) {
  return page.evaluate(() => {
    const version = document.querySelector(
      '[data-slot="openbot-version"]',
    ) as HTMLElement;
    const name = version.previousElementSibling as HTMLElement;
    const row = version.parentElement as HTMLElement;
    const button = row.parentElement as HTMLElement;
    const words = document.createRange();
    words.selectNodeContents(version);
    const text = words.getBoundingClientRect();
    const box = row.getBoundingClientRect();
    const edge = button.getBoundingClientRect();
    return {
      text: version.textContent,
      versionCut: version.scrollWidth > version.clientWidth,
      rowCut: row.scrollWidth > row.clientWidth,
      // The words' own box inside the row and the button, which clip what runs past them.
      versionInside:
        text.left >= box.left - 0.5 &&
        text.right <= box.right + 0.5 &&
        text.right <= edge.right + 0.5,
      // How far the words end from the row's right edge: a version sits flush right.
      fromRight: Math.round(box.right - text.right),
      fontSize: getComputedStyle(version).fontSize,
      nameCut: name.scrollWidth > name.clientWidth,
    };
  });
}

describe.skipIf(!asked)("the version in the sidebar's account row", () => {
  for (const width of WIDTHS) {
    for (const version of BUILDS) {
      test(`at ${width}px, ${version} reads whole and the long name gives way`, async () => {
        const page = await open(width, LONG_NAME, version);
        try {
          expect(await measured(page)).toMatchObject({
            text: version,
            versionCut: false,
            rowCut: false,
            versionInside: true,
            fromRight: 0,
            nameCut: true,
          });
        } finally {
          await page.close();
        }
      }, 60_000);
    }

    test.skipIf(!shots)(
      `screenshots at ${width}px`,
      async () => {
        if (!shots) return;
        mkdirSync(shots, { recursive: true });
        for (const [label, name, version] of [
          ["build", LONG_NAME, BUILDS[0]],
          ["release", "Sam Rivera", RELEASE],
        ] as const) {
          const page = await open(width, name, version);
          try {
            await page.screenshot({
              path: join(shots, `account-version-${label}-${width}.png`),
              clip: { x: 0, y: 0, width, height: 64 },
            });
          } finally {
            await page.close();
          }
        }
      },
      60_000,
    );

    test(`at ${width}px, a release's ${RELEASE} sits flush right in tiny type`, async () => {
      const page = await open(width, "Sam", RELEASE);
      try {
        expect(await measured(page)).toMatchObject({
          text: RELEASE,
          versionCut: false,
          versionInside: true,
          fromRight: 0,
          fontSize: "10px",
          nameCut: false,
        });
      } finally {
        await page.close();
      }
    }, 60_000);
  }
});
