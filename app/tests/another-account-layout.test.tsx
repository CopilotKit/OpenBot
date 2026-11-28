import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Browser, BrowserType, Page } from "playwright-core";
import { compile } from "tailwindcss";
import { myAccountPath, myConnectionPath } from "./connections-api";

/**
 * The card for one more account at an app, in a real browser, in the app's stylesheet.
 *
 * Reported in dogfooding: asked "Can I connect you to my personal email as well?" by somebody whose
 * work Gmail was connected, a Bot showed Gmail's card reading "Gmail is ready now" and three how-to
 * guides. Now it puts up one card, whose Connect another account starts the second account's sign-in
 * in a tab claimed on the click, as Connections does, and once that account is listed says which one
 * Bots use and offers Make default. another-account-card.test.tsx holds the behaviour; this drives it
 * with a real mouse, light and dark.
 *
 *   OPENBOT_APP_BROWSER=1 bun test app/tests/another-account-layout.test.tsx
 *
 * Chromium by default, as CI has it. OPENBOT_APP_ENGINES=chromium,webkit adds WebKit. With
 * OPENBOT_APP_SHOTS=<dir> each step is saved as another-account-<step>-<engine>-<theme>.png.
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

const APP_DIR = join(import.meta.dir, "..");
const ORIGIN = "http://openbot.test";
const GMAIL = "composio-gmail";
const PERSONAL = "00000000-0000-4000-8000-000000000002";

/** The fixture bundled for the browser. `@/lib/marks` is Vite's `import.meta.glob`, so no marks. */
async function bundle(): Promise<string> {
  const built = await Bun.build({
    entrypoints: [join(import.meta.dir, "another-account-layout.fixture.tsx")],
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
    join(APP_DIR, "node_modules", name),
    join(APP_DIR, "..", "node_modules", name),
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
  const tailwind = dirname(
    Bun.resolveSync("tailwindcss/package.json", APP_DIR),
  );
  const entry = join(APP_DIR, "src", "styles.css");
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
      Promise.all(document.getAnimations().map((motion) => motion.finished)),
      new Promise((done) => setTimeout(done, 1_500)),
    ]),
  );
}

/** The fixture, in a window the width of a desktop app, or of a phone. */
async function open(
  engine: string,
  theme: "light" | "dark",
  width = 1000,
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
    if (path === "/another-account.js")
      return route.fulfill({ contentType: "text/javascript", body: script });
    const font = join(inter, path.split("/").pop() ?? "");
    if (path.startsWith("/files/") && existsSync(font))
      return route.fulfill({ path: font });
    if (path.startsWith("/api/")) return route.fulfill({ status: 404 });
    return route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html lang="en" class="${theme}" style="color-scheme: ${theme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head><body><div id="root"></div><script type="module" src="/another-account.js"></script></body></html>`,
    });
  });
  await page.goto(`${ORIGIN}/?theme=${theme}`);
  return page;
}

async function shoot(page: Page, step: string, name: string) {
  if (!shots) return;
  mkdirSync(shots, { recursive: true });
  await page.screenshot({
    path: join(shots, `another-account-${step}-${name}.png`),
  });
}

/** How the card's control sits: inside the card, on one line, nothing running off the side. */
function fits(page: Page) {
  return page.locator("[data-another-account]").evaluate((element) => {
    const box = element.getBoundingClientRect();
    const control = element.querySelector("button, a") as HTMLElement;
    const inner = control.getBoundingClientRect();
    return {
      inside: inner.left >= box.left && inner.right <= box.right,
      oneLine: inner.height < 40,
      sideways: document.documentElement.scrollWidth > innerWidth,
    };
  });
}

/** What the page did about Gmail and its tab, leaving out the conversation's own requests. */
const events = async (page: Page) =>
  (
    await page.evaluate(
      () => (window as unknown as { __events: string[] }).__events,
    )
  ).filter((event) => event.includes(GMAIL) || event.startsWith("tab "));

describe.skipIf(!asked)("the card for one more account", () => {
  for (const engine of engines)
    for (const theme of ["light", "dark"] as const) {
      const name = `${engine}-${theme}`;

      test(`one card starts the second account's sign-in, then offers Make default, in ${engine}, ${theme}`, async () => {
        const page = await open(engine, theme);
        try {
          const card = page.locator("[data-another-account]");
          const connect = card.getByRole("button", {
            name: "Connect another Gmail account",
          });
          await connect.waitFor({ timeout: 15_000 });
          await style(page);
          await shoot(page, "card", name);
          // One card, never the app's own "ready now" card beside it.
          expect(await card.count()).toBe(1);
          expect(await page.locator("[data-app-access]").count()).toBe(0);
          expect(await page.getByText(/ready now/).count()).toBe(0);
          expect(await card.textContent()).toContain(
            "Connect another Gmail account. Bots keep using sam.rivera@work.example until you make another the default.",
          );
          expect(await connect.textContent()).toBe("Connect another account");
          expect(await fits(page)).toEqual({
            inside: true,
            oneLine: true,
            sideways: false,
          });

          await connect.click();
          await page
            .getByText("Finish in the tab that opened.")
            .waitFor({ timeout: 15_000 });
          await style(page);
          await shoot(page, "signing-in", name);
          // Claimed on the click, then the same press Connections' Connect another account makes.
          const seen = await events(page);
          expect(seen.slice(0, 2)).toEqual([
            "tab claimed",
            `POST ${myConnectionPath(GMAIL, "connect")} {"returnTo":"connections","anotherAccount":true}`,
          ]);
          expect(seen[2]?.startsWith("tab to ")).toBe(true);

          // The second account is listed on the card's next read.
          await card
            .getByRole("button", {
              name: "Make sam.rivera@home.example the default",
            })
            .waitFor({ timeout: 15_000 });
          await style(page);
          await shoot(page, "connected", name);
          expect(await card.textContent()).toContain(
            "sam.rivera@home.example is connected. Bots use sam.rivera@work.example unless you ask for sam.rivera@home.example.",
          );
          expect(await fits(page)).toEqual({
            inside: true,
            oneLine: true,
            sideways: false,
          });

          await card
            .getByRole("button", { name: /Make .* the default/ })
            .click();
          await page
            .getByText(
              "sam.rivera@home.example is connected. Bots use it by default.",
            )
            .waitFor({ timeout: 15_000 });
          await style(page);
          await shoot(page, "made-default", name);
          expect(await events(page)).toContain(
            `POST ${myAccountPath(GMAIL, PERSONAL, "make-default")}`,
          );
        } finally {
          await page.close();
        }
      }, 90_000);

      test(`the card in a narrow window, in ${engine}, ${theme}`, async () => {
        const page = await open(engine, theme, 390);
        try {
          const card = page.locator("[data-another-account]");
          await card
            .getByRole("button", { name: "Connect another Gmail account" })
            .waitFor({ timeout: 15_000 });
          await style(page);
          await shoot(page, "narrow", name);
          expect(await fits(page)).toEqual({
            inside: true,
            oneLine: true,
            sideways: false,
          });
        } finally {
          await page.close();
        }
      }, 90_000);
    }
});
