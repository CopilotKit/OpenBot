import { afterAll, beforeAll, describe, expect } from "bun:test";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Browser, BrowserType, Page } from "playwright-core";
import { compile } from "tailwindcss";
import { myConnectionPath } from "./connections-api";
import { test } from "./renderer-crash";

/**
 * Reconnect on apps that sign in, in a real browser: one press reaches the sign-in, and the screen
 * it was pressed on stays, saying it is working, until the sign-in opens.
 *
 * A card in a conversation for Gmail, which signs in through the directory and whose account the
 * vendor lost; Connections, where Notion's grant was withdrawn at Notion; and Notion's own page.
 * sign-in-reconnect-one-press.test.tsx and app-access-action.test.tsx hold the behaviour; this
 * drives it with a real mouse in the app's stylesheet, at a desktop window's width and a phone's.
 *
 *   OPENBOT_APP_BROWSER=1 bun test app/tests/sign-in-reconnect-layout.test.tsx
 *
 * Chromium by default, as CI has it. OPENBOT_APP_ENGINES=chromium,webkit adds WebKit. With
 * OPENBOT_APP_SHOTS=<dir> each step is saved as sign-in-reconnect-<step>-<engine>-<theme>-<width>.png.
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
const WIDTHS = {
  desktop: { width: 1000, height: 760 },
  phone: { width: 390, height: 844 },
} as const;

/** The fixture bundled for the browser. `@/lib/marks` is Vite's `import.meta.glob`, so no marks. */
async function bundle(): Promise<string> {
  const built = await Bun.build({
    entrypoints: [
      join(import.meta.dir, "sign-in-reconnect-layout.fixture.tsx"),
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
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(() =>
    Promise.race([
      Promise.all(
        document
          .getAnimations()
          .map((motion) => motion.finished.catch(() => undefined)),
      ),
      new Promise((done) => setTimeout(done, 1_500)),
    ]),
  );
}

/** The fixture at `path`, in a window `width` wide. */
async function open(
  engine: string,
  theme: "light" | "dark",
  width: keyof typeof WIDTHS,
  path: string,
): Promise<Page> {
  const browser = browsers.get(engine);
  if (!browser) throw new Error(`no ${engine}`);
  const page = await browser.newPage({
    viewport: WIDTHS[width],
    colorScheme: theme,
    reducedMotion: "reduce",
  });
  page.on("pageerror", (error) => console.error(error));
  const inter = join(packageDir("@fontsource-variable/inter"), "files");
  await page.route(`${ORIGIN}/**`, (route) => {
    const at = new URL(route.request().url()).pathname;
    if (at === "/sign-in-reconnect.js")
      return route.fulfill({ contentType: "text/javascript", body: script });
    const font = join(inter, at.split("/").pop() ?? "");
    if (at.startsWith("/files/") && existsSync(font))
      return route.fulfill({ path: font });
    // The fixture answers the API itself; anything that reaches the network has nowhere to go.
    if (at.startsWith("/api/")) return route.fulfill({ status: 404 });
    return route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html lang="en" class="${theme}" style="color-scheme: ${theme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head><body><div id="root"></div><script type="module" src="/sign-in-reconnect.js"></script></body></html>`,
    });
  });
  const join_ = path.includes("?") ? "&" : "?";
  await page.goto(`${ORIGIN}${path}${join_}theme=${theme}`);
  return page;
}

async function shoot(page: Page, step: string, name: string) {
  if (!shots) return;
  mkdirSync(shots, { recursive: true });
  await page.screenshot({
    path: join(shots, `sign-in-reconnect-${step}-${name}.png`),
  });
}

/** What the page did, in order: its writes, and each tab claimed, sent somewhere, or closed. */
const events = (page: Page) =>
  page.evaluate(() => (window as unknown as { __events: string[] }).__events);

/** The writes and tabs about one app, leaving out an app page's own check on arrival. */
async function appEvents(page: Page, app: string) {
  return (await events(page)).filter(
    (event) =>
      (event.includes(app) && !event.endsWith("/confirm")) ||
      event.startsWith("tab "),
  );
}

/** Whether anything runs off the side of the window. */
const sideways = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth > innerWidth);

const release = (page: Page) =>
  page.evaluate(() =>
    (window as unknown as { __release: () => void }).__release(),
  );

describe.skipIf(!asked)("Reconnect on an app that signs in", () => {
  for (const engine of engines)
    for (const theme of ["light", "dark"] as const)
      for (const width of ["desktop", "phone"] as const) {
        const name = `${engine}-${theme}-${width}`;

        test(`a card's Reconnect on Gmail opens its sign-in in one press, and the conversation stays, in ${name}`, async () => {
          const page = await open(engine, theme, width, "/?held=1");
          try {
            const drawn = page.locator("[data-app-access]");
            await drawn
              .getByRole("button", { name: "Reconnect Gmail" })
              .waitFor({ timeout: 15_000 });
            await style(page);
            await shoot(page, "card", name);
            expect(await sideways(page)).toBe(false);

            await drawn
              .getByRole("button", { name: "Reconnect Gmail" })
              .click();
            // The sign-in is being asked for: the conversation stays, and the card says so.
            await drawn
              .getByRole("button", { name: "Opening sign-in…" })
              .waitFor({ timeout: 5_000 })
              .catch(() => {});
            await style(page);
            await shoot(page, "card-opening", name);
            expect(new URL(page.url()).pathname).toBe("/");
            expect(
              await drawn
                .getByRole("button", { name: "Opening sign-in…" })
                .isDisabled(),
            ).toBe(true);

            await release(page);
            await page
              .getByText("Finish in the tab that opened.")
              .waitFor({ timeout: 15_000 });
            await style(page);
            await shoot(page, "card-waiting", name);
            expect(new URL(page.url()).pathname).toBe("/");
            expect(await sideways(page)).toBe(false);
            // The tab claimed on the click, the sign-in asked for, and the tab sent on to it.
            const seen = await appEvents(page, "composio-gmail");
            expect(seen.slice(0, 2)).toEqual([
              "tab claimed",
              `POST ${myConnectionPath("composio-gmail", "connect")}`,
            ]);
            expect(seen).toHaveLength(3);
            expect(seen[2].startsWith("tab to ")).toBe(true);
          } finally {
            await page.close();
          }
        }, 90_000);

        test(`Connections: Notion's tile says Reconnect, and one press reaches its sign-in, in ${name}`, async () => {
          const page = await open(engine, theme, width, "/connections?held=1");
          try {
            const tile = page.getByTestId("account-notion");
            await tile.waitFor({ timeout: 15_000 });
            await style(page);
            await shoot(page, "tiles", name);
            expect(await tile.textContent()).toContain("Reconnect");
            expect(await sideways(page)).toBe(false);

            await tile.click();
            // On Notion's page, its sign-in asked for on arrival and saying so.
            await page
              .getByRole("button", { name: "Connecting…" })
              .waitFor({ timeout: 5_000 })
              .catch(() => {});
            await style(page);
            await shoot(page, "tile-pressed", name);
            expect(await appEvents(page, "notion")).toEqual([
              `POST ${myConnectionPath("notion", "connect")}`,
            ]);
          } finally {
            await page.close();
          }
        }, 90_000);

        test(`Notion's own page offers Reconnect over the withdrawn sign-in, in ${name}`, async () => {
          const page = await open(
            engine,
            theme,
            width,
            "/connections/notion?held=1",
          );
          try {
            await page
              .getByText("Your Notion connection needs reconnecting.")
              .waitFor({ timeout: 15_000 })
              .catch(() => {});
            await style(page);
            await shoot(page, "app-page", name);
            expect(await sideways(page)).toBe(false);
            const reconnect = page.getByRole("button", { name: "Reconnect" });
            await reconnect.click({ timeout: 5_000 });
            await page
              .getByRole("button", { name: "Connecting…" })
              .waitFor({ timeout: 5_000 });
            await style(page);
            await shoot(page, "app-page-connecting", name);
            expect(await appEvents(page, "notion")).toEqual([
              `POST ${myConnectionPath("notion", "connect")}`,
            ]);
          } finally {
            await page.close();
          }
        }, 90_000);
      }
});
