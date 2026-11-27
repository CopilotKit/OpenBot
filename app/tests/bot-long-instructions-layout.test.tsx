import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Browser, Page } from "playwright-core";
import { compile } from "tailwindcss";
import { still } from "./page-still";

/**
 * A Bot's instructions at the most they take, 5000 characters, in a real browser, in light and
 * dark, wide and on a phone: its Setup page, the What it does dialog holding all 5000, the same
 * dialog refusing a 5001st, and the New Bot sheet's Instructions holding 5000.
 *
 * Drawn from bot-long-instructions-layout.fixture.tsx, styled by the app's stylesheet: the page never
 * scrolls sideways, the dialog stays inside the window with Save in view, and the refusal is shown
 * where it can be read.
 *
 *   OPENBOT_APP_BROWSER=1 bun test app/tests/bot-long-instructions-layout.test.tsx
 *
 * Chromium by default. OPENBOT_APP_ENGINES=chromium,webkit adds WebKit. With OPENBOT_APP_SHOTS=<dir>
 * each screen is saved as <screen>-<engine>-<theme>-<width>.png.
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
      join(import.meta.dir, "bot-long-instructions-layout.fixture.tsx"),
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

// Closing two browsers takes longer than a hook's five seconds when the machine runs eight files at once.
afterAll(async () => {
  await Promise.all(browsers.map((browser) => browser.close()));
}, 30_000);

/**
 * Style what is on the page now, as the app's build would have, and let it settle.
 *
 * Styles that arrive after the page has drawn start the transitions they declare: the dialog slides
 * from where it sat unstyled to the middle of the window over 150ms. A fixed wait measured it partway
 * there, off the screen, whenever WebKit ran slow under a full CI run, so this waits until the page
 * is still, then measures what a person would see.
 */
async function styled(page: Page) {
  const classes = await page.evaluate(() =>
    [...document.querySelectorAll("[class]")].flatMap((element) => [
      ...element.classList,
    ]),
  );
  await page.addStyleTag({ content: await stylesheet([...new Set(classes)]) });
  await page.evaluate(() => document.fonts.ready);
  await still(page);
}

async function open(
  name: "chromium" | "webkit",
  theme: (typeof THEMES)[number],
  window: { width: number; height: number },
  screen: "setup" | "new-bot",
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
    if (url.pathname.includes("."))
      return route.fulfill({ status: 404, body: "" });
    return route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html lang="en" class="${theme}" style="color-scheme: ${theme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head><body><div id="root"></div><script type="module" src="/app.js"></script></body></html>`,
    });
  });
  await page.goto(`${ORIGIN}/?screen=${screen}`, {
    waitUntil: "domcontentloaded",
  });
  return page;
}

async function shoot(page: Page, file: string) {
  if (!shots) return;
  mkdirSync(shots, { recursive: true });
  await page.screenshot({ path: join(shots, file) });
}

/** Whether the page scrolls sideways, and the dialog's place, Save's and the refusal's. */
function measure(page: Page) {
  return page.evaluate(() => {
    const inside = (element: Element | null | undefined) => {
      const box = element?.getBoundingClientRect();
      return (
        !!box &&
        box.width > 0 &&
        box.left >= 0 &&
        box.top >= 0 &&
        box.right <= innerWidth &&
        box.bottom <= innerHeight
      );
    };
    const dialog = document.querySelector("[role=dialog]");
    const save = [...(dialog?.querySelectorAll("button") ?? [])].find(
      (button) => button.textContent === "Save",
    );
    const alert = dialog?.querySelector("[role=alert]");
    // Seen in the body's scrolled view, not under the footer or above the header.
    const body = dialog?.querySelector("[data-slot=dialog-body]");
    const bodyBox = body?.getBoundingClientRect();
    const alertBox = alert?.getBoundingClientRect();
    return {
      sideways:
        document.documentElement.scrollWidth > innerWidth ||
        document.body.scrollWidth > innerWidth,
      dialogInside: inside(dialog),
      saveInside: inside(save),
      alert: alert?.textContent ?? null,
      alertSeen:
        !!alertBox &&
        !!bodyBox &&
        alertBox.top >= bodyBox.top - 1 &&
        alertBox.bottom <= bodyBox.bottom + 1,
    };
  });
}

describe.skipIf(!asked)("a Bot's instructions at 5000 characters", () => {
  for (const engine of engines)
    for (const theme of THEMES)
      for (const window of WINDOWS) {
        const at = `${engine}-${theme}-${window.width}`;

        test(`Setup holds them, and What it does saves all 5000 and refuses a 5001st, in ${engine}, ${theme}, ${window.width}px`, async () => {
          const page = await open(engine, theme, window, "setup");
          const row = page.getByRole("button", { name: /^What it does/ });
          await row.waitFor();
          await styled(page);
          expect((await measure(page)).sideways).toBe(false);
          await shoot(page, `setup-${at}.png`);

          await row.click();
          const field = page.getByRole("textbox", { name: "What it does" });
          await field.waitFor();
          await styled(page);
          expect(await field.inputValue()).toHaveLength(5000);
          const editing = await measure(page);
          expect(editing.sideways).toBe(false);
          expect(editing.dialogInside).toBe(true);
          expect(editing.saveInside).toBe(true);
          await shoot(page, `what-it-does-5000-${at}.png`);

          await field.press("ControlOrMeta+End");
          await field.pressSequentially("!");
          await page.getByRole("button", { name: "Save" }).click();
          await page.getByRole("alert").waitFor();
          await styled(page);
          const refused = await measure(page);
          expect(refused.alert).toBe(
            "What it does must be 5000 characters or fewer.",
          );
          expect(refused.alertSeen).toBe(true);
          expect(refused.saveInside).toBe(true);
          expect(refused.sideways).toBe(false);
          await shoot(page, `what-it-does-5001-${at}.png`);

          await field.press("Backspace");
          await page.getByRole("button", { name: "Save" }).click();
          await page.getByRole("dialog").waitFor({ state: "hidden" });
          expect((await measure(page)).sideways).toBe(false);
          await page.close();
        }, 90_000);

        test(`New Bot's Instructions hold 5000 characters, in ${engine}, ${theme}, ${window.width}px`, async () => {
          const page = await open(engine, theme, window, "new-bot");
          const field = page.getByLabel(/^Instructions/);
          await field.waitFor();
          await page.getByLabel("Name").fill("Expense Review");
          const most = "Check each receipt against the policy. ".repeat(130);
          await field.fill(`${most.slice(0, 5000)}more`);
          await styled(page);
          expect(await field.inputValue()).toHaveLength(5000);
          expect((await measure(page)).sideways).toBe(false);
          await shoot(page, `new-bot-5000-${at}.png`);
          await page.close();
        }, 90_000);
      }
});
