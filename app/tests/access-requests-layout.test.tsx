import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Browser, BrowserType, Locator, Page } from "playwright-core";
import { compile } from "tailwindcss";

/**
 * An admin's Requests section in a real browser, in an organization whose apps are open and in one
 * locked down: each row says what approving gives in that mode, in the same text style and place,
 * so nothing runs off the row at a desktop app's width or a phone's. access-requests.test.tsx holds
 * the behaviour.
 *
 *   OPENBOT_APP_BROWSER=1 bun test app/tests/access-requests-layout.test.tsx
 *
 * Chromium by default, as CI has it. OPENBOT_APP_ENGINES=chromium,webkit adds WebKit. With
 * OPENBOT_APP_SHOTS=<dir> each page is saved as access-requests-<apps>-<engine>-<theme>-<width>.png.
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
const WIDTHS = [1000, 390];

const SAID = {
  open: {
    gmail:
      "Approving gives Expenses every Gmail action. Choose fewer on the Bot's page under Gmail.",
    notion:
      "Approving gives Research Assistant every Notion action. Choose fewer on the Bot's page under Notion.",
  },
  locked: {
    gmail:
      "Approving gives Expenses only Gmail's read-only actions. Choose any others on the Bot's page under Gmail.",
    notion:
      "Approving gives Research Assistant only Notion's read-only actions. Choose any others on the Bot's page under Notion.",
  },
} as const;
const NAMED =
  "Approving gives Calendar Bot only GOOGLECALENDAR_PATCH_EVENT. Choose any others on the Bot's page under Google Calendar.";

/** The fixture bundled for the browser. `@/lib/marks` is Vite's `import.meta.glob`, so no marks. */
async function bundle(): Promise<string> {
  const built = await Bun.build({
    entrypoints: [join(import.meta.dir, "access-requests-layout.fixture.tsx")],
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
  await page.evaluate(() => document.fonts.ready);
}

/** The fixture, `width` wide, with apps open or locked down. */
async function open(
  engine: string,
  theme: "light" | "dark",
  width: number,
  apps: "open" | "locked",
): Promise<Page> {
  const browser = browsers.get(engine);
  if (!browser) throw new Error(`no ${engine}`);
  const page = await browser.newPage({
    viewport: { width, height: 760 },
    colorScheme: theme,
    reducedMotion: "reduce",
  });
  page.on("pageerror", (error) => console.error(error));
  const inter = join(packageDir("@fontsource-variable/inter"), "files");
  await page.route(`${ORIGIN}/**`, (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/access-requests.js")
      return route.fulfill({ contentType: "text/javascript", body: script });
    const font = join(inter, path.split("/").pop() ?? "");
    if (path.startsWith("/files/") && existsSync(font))
      return route.fulfill({ path: font });
    // The fixture answers the API itself; anything that reaches the network has nowhere to go.
    if (path.startsWith("/api/")) return route.fulfill({ status: 404 });
    return route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html lang="en" class="${theme}" style="color-scheme: ${theme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head><body><div id="root"></div><script type="module" src="/access-requests.js"></script></body></html>`,
    });
  });
  await page.goto(`${ORIGIN}/?apps=${apps}&theme=${theme}`);
  return page;
}

/** Whether everything in `box` sits inside it, and nothing on the page scrolls sideways. */
function fits(box: Locator) {
  return box.evaluate((element) => {
    const outer = element.getBoundingClientRect();
    const inside = [...element.querySelectorAll("p, span, button, a")].every(
      (child) => {
        const inner = child.getBoundingClientRect();
        return (
          inner.width === 0 ||
          (inner.left >= outer.left - 0.5 && inner.right <= outer.right + 0.5)
        );
      },
    );
    return {
      inside,
      sideways: document.documentElement.scrollWidth > innerWidth,
    };
  });
}

describe.skipIf(!asked)("what approving gives, on an admin's Requests", () => {
  for (const engine of engines)
    for (const theme of ["light", "dark"] as const)
      for (const width of WIDTHS)
        for (const apps of ["open", "locked"] as const) {
          const name = `${apps}-${engine}-${theme}-${width}`;
          test(`each row says what approving gives with apps ${apps}, in ${engine}-${theme}-${width}`, async () => {
            const page = await open(engine, theme, width, apps);
            try {
              const gmail = page.locator('[data-request="req_gmail"]');
              await gmail.waitFor({ timeout: 15_000 });
              const notion = page.locator('[data-request="req_notion"]');
              const calendar = page.locator('[data-request="req_calendar"]');
              await style(page);
              if (shots) {
                mkdirSync(shots, { recursive: true });
                await page.screenshot({
                  path: join(shots, `access-requests-${name}.png`),
                  fullPage: true,
                });
              }
              expect(await gmail.textContent()).toContain(SAID[apps].gmail);
              expect(await notion.textContent()).toContain(SAID[apps].notion);
              expect(await calendar.textContent()).toContain(NAMED);
              for (const row of [gmail, notion, calendar])
                expect(await fits(row)).toEqual({
                  inside: true,
                  sideways: false,
                });
            } finally {
              await page.close();
            }
          }, 90_000);
        }
});
