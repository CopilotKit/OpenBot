import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Browser, BrowserType, Page } from "playwright-core";
import { compile } from "tailwindcss";
import { still } from "./page-still";

/**
 * A conversation opened while the OpenBot it is connected to can't be reached, in a real browser.
 *
 * Seen on a real Windows computer: under the connection line the conversation's pane was blank,
 * with no title. Now its header names it from the sidebar's list and the pane says, in quiet type,
 * that it will show when OpenBot answers. connection-lost-conversation-route.test.tsx holds the
 * behaviour; this looks at it in the app's real frame with the app's stylesheet.
 *
 *   OPENBOT_APP_BROWSER=1 bun test app/tests/offline-conversation-layout.test.tsx
 *
 * Chromium by default, as CI has it. OPENBOT_APP_ENGINES=chromium,webkit adds WebKit. With
 * OPENBOT_APP_SHOTS=<dir> each is saved as offline-conversation-<engine>-<theme>-<width>.png.
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
const PLACEHOLDER = "This conversation will show here when OpenBot answers.";

/** The fixture bundled for the browser. `@/lib/marks` is Vite's `import.meta.glob`, so no marks. */
async function bundle(): Promise<string> {
  const built = await Bun.build({
    entrypoints: [
      join(import.meta.dir, "offline-conversation-layout.fixture.tsx"),
    ],
    target: "browser",
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    plugins: [
      {
        name: "no-marks",
        setup(build) {
          build.onResolve({ filter: /^@\/lib\/marks$/ }, () => ({
            path: "marks",
            namespace: "no-marks",
          }));
          build.onLoad({ filter: /.*/, namespace: "no-marks" }, () => ({
            contents: "export const markFor = () => null;",
            loader: "js",
          }));
        },
      },
    ],
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

/** Styled for everything now on the page. */
async function style(page: Page) {
  const classes = await page.evaluate(() =>
    [...document.querySelectorAll("[class]")].flatMap((element) => [
      ...element.classList,
    ]),
  );
  await page.addStyleTag({ content: await stylesheet([...new Set(classes)]) });
}

/** The conversation opened while OpenBot can't be reached. */
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
    if (path === "/conversation.js")
      return route.fulfill({ contentType: "text/javascript", body: script });
    const font = join(inter, path.split("/").pop() ?? "");
    if (path.startsWith("/files/") && existsSync(font))
      return route.fulfill({ path: font });
    // The desktop app's relay, for an OpenBot that does not answer.
    if (path.startsWith("/api/"))
      return route.fulfill({
        status: 502,
        contentType: "text/plain; charset=utf-8",
        body: "OpenBot could not be reached.",
      });
    return route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html lang="en" class="${theme}" style="color-scheme: ${theme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head><body><div id="root"></div><script type="module" src="/conversation.js"></script></body></html>`,
    });
  });
  await page.goto(`${ORIGIN}/channel/away-conversation`);
  await page.getByText(PLACEHOLDER).waitFor({ timeout: 15_000 });
  await style(page);
  // The frame settles after the first styling (the sidebar measures itself), so again for what it drew then.
  await still(page);
  await style(page);
  await page.evaluate(() => document.fonts.ready);
  return page;
}

describe.skipIf(!asked)(
  "a conversation opened while OpenBot can't be reached",
  () => {
    for (const engine of engines)
      for (const theme of ["light", "dark"] as const)
        for (const window of [
          { width: 1440, height: 900 },
          { width: 700, height: 800 },
        ])
          test(`has its title and a quiet line saying it will show, in ${engine}, ${theme}, ${window.width}px`, async () => {
            const page = await open(engine, theme, window);
            try {
              if (shots) {
                mkdirSync(shots, { recursive: true });
                await page.screenshot({
                  path: join(
                    shots,
                    `offline-conversation-${engine}-${theme}-${window.width}.png`,
                  ),
                });
              }
              const header = page.locator('[data-slot="conversation-header"]');
              expect(await header.textContent()).toContain("Release Bot");
              const drawn = await page
                .getByText(PLACEHOLDER)
                .evaluate((line) => {
                  const rect = line.getBoundingClientRect();
                  const muted = document.createElement("span");
                  muted.className = "text-muted-foreground";
                  document.body.append(muted);
                  const quiet = getComputedStyle(muted).color;
                  muted.remove();
                  return {
                    inside: rect.left >= 0 && rect.right <= innerWidth,
                    sideways: document.documentElement.scrollWidth > innerWidth,
                    quiet: getComputedStyle(line).color === quiet,
                  };
                });
              expect(drawn).toEqual({
                inside: true,
                sideways: false,
                quiet: true,
              });
              expect(await page.getByRole("alert").count()).toBe(0);
            } finally {
              await page.close();
            }
          }, 90_000);
  },
);
