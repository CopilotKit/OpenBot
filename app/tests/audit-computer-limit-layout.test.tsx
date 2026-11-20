import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Browser, Page } from "playwright-core";
import { compile } from "tailwindcss";

/**
 * Admin's Activity with a computer refused at a limit, in a real browser, in light and dark, wide and on a phone.
 *
 * Seen after a person was refused a computer because the organization had no room: the row read "Start a new
 * computer · A Bot no longer here · Started by a person · Allowed". Drawn here from
 * audit-computer-limit-layout.fixture.tsx, styled by the app's stylesheet: every limit's row says Blocked in the
 * refusal's colour with which limit it was, names the Bot that asked, and the page never scrolls sideways.
 *
 *   OPENBOT_APP_BROWSER=1 bun test app/tests/audit-computer-limit-layout.test.tsx
 *
 * Chromium by default, as CI has it. OPENBOT_APP_ENGINES=chromium,webkit adds WebKit. With OPENBOT_APP_SHOTS=<dir>
 * each page is saved as activity-computer-limit-<engine>-<theme>-<width>.png.
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
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
];

async function bundle(): Promise<string> {
  const built = await Bun.build({
    entrypoints: [
      join(import.meta.dir, "audit-computer-limit-layout.fixture.tsx"),
    ],
    target: "browser",
    external: ["maplibre-gl"],
    // `@/lib/marks` is Vite's `import.meta.glob`, so no brand marks, as in the other browser tests.
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
    define: {
      "process.env.NODE_ENV": JSON.stringify("production"),
      "import.meta.env.DEV": "false",
      "import.meta.env.PROD": "true",
      "import.meta.env.MODE": JSON.stringify("production"),
    },
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
if (asked) script = await bundle();
const browsers: Browser[] = [];

afterAll(async () => {
  await Promise.all(browsers.map((browser) => browser.close()));
});

async function open(
  name: "chromium" | "webkit",
  theme: (typeof THEMES)[number],
  window: { width: number; height: number },
): Promise<Page> {
  const playwright = await import("playwright-core");
  const engine = playwright[name];
  const browser =
    name === "chromium"
      ? // The CI job installs full Chromium without the headless shell.
        await engine.launch({ channel: "chromium" })
      : await engine.launch();
  browsers.push(browser);
  const page = await browser.newPage({
    viewport: window,
    colorScheme: theme,
    reducedMotion: "reduce",
  });
  page.on("pageerror", (error) => console.error(error));
  await page.route(`${ORIGIN}/**`, (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/app.js")
      return route.fulfill({ contentType: "text/javascript", body: script });
    if (url.pathname.startsWith("/api/"))
      return route.fulfill({ status: 404, json: { error: "not here" } });
    if (url.pathname.includes("."))
      return route.fulfill({ status: 404, body: "" });
    return route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html lang="en" class="${theme}" style="color-scheme: ${theme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head><body><div id="root"></div><script type="module" src="/app.js"></script></body></html>`,
    });
  });
  await page.goto(`${ORIGIN}/`, { waitUntil: "domcontentloaded" });
  await page.getByText("Decision").first().waitFor();
  const classes = await page.evaluate(() =>
    [...document.querySelectorAll("[class]")].flatMap((element) => [
      ...element.classList,
    ]),
  );
  await page.addStyleTag({ content: await stylesheet([...new Set(classes)]) });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(400);
  return page;
}

describe.skipIf(!asked)("a computer refused at a limit, on Activity", () => {
  for (const engine of engines)
    for (const theme of THEMES)
      for (const window of WINDOWS)
        test(`reads as blocked, by which limit, in ${engine}, ${theme}, ${window.width}px`, async () => {
          const page = await open(engine, theme, window);
          const seen = await page.evaluate(() => {
            const rows = [...document.querySelectorAll("tbody tr")].map(
              (tr) => {
                const decision = tr.querySelector("[data-column=decision]");
                const mark = decision?.querySelector("span");
                return {
                  bot: tr.querySelector("[data-column=bot] > div")?.textContent,
                  decision: [...(decision?.children ?? [])].map(
                    (line) => line.textContent,
                  ),
                  colour: mark ? getComputedStyle(mark).color : null,
                  muted: getComputedStyle(document.body).color,
                };
              },
            );
            return {
              rows,
              sideways:
                document.documentElement.scrollWidth > innerWidth ||
                document.body.scrollWidth > innerWidth,
              text: document.body.innerText,
            };
          });
          if (shots) {
            mkdirSync(shots, { recursive: true });
            await page.screenshot({
              path: join(
                shots,
                `activity-computer-limit-${engine}-${theme}-${window.width}.png`,
              ),
              fullPage: true,
            });
          }
          expect(seen.sideways).toBe(false);
          expect(seen.text).not.toContain("A Bot no longer here");
          expect(seen.text).not.toContain("Allowed");
          expect(seen.rows.map((row) => row.decision)).toEqual([
            ["Blocked", "This organization is at its limit of 1 computer."],
            [
              "Blocked",
              "This person is at their limit of 2 computers in this organization.",
            ],
            [
              "Blocked",
              "This organization is at its limit of 1 computer.",
              "The computer was for their own browser.",
            ],
            ["Blocked", "OpenBot is at its limit of 8 computers."],
          ]);
          // Who it was for, by the address the People page shows.
          expect(
            seen.text.match(/Started by ben\.okafor@northwind\.example/g)
              ?.length,
          ).toBe(4);
          expect(seen.rows.map((row) => row.bot)).toEqual([
            "Notes",
            "Notes",
            "-",
            "Notes",
          ]);
          // Blocked is drawn in the refusal's colour, never the muted one the rest of the row uses.
          for (const row of seen.rows) expect(row.colour).not.toBe(row.muted);
          await page.close();
        }, 60_000);
});
