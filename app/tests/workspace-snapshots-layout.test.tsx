import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Browser, Page } from "playwright-core";
import { compile } from "tailwindcss";

/**
 * A Bot's saved copies hold their layout, drawn by a real Chromium with the app's stylesheet: the
 * list after a restore went well, a restore under way, one that failed, the confirmation, a refusal
 * beside its buttons, and an admin's dialog of another person's copies with its confirmation over
 * it. Each in light and dark, at a laptop's width and a phone's: the page never scrolls sideways and
 * every dialog is whole inside the window.
 *
 *   OPENBOT_APP_BROWSER=1 bun test app/tests/workspace-snapshots-layout.test.tsx
 *
 * With OPENBOT_APP_SHOTS=<dir> it also saves each as copies-<state>-<theme>-<width>.png.
 */
const asked = process.env.OPENBOT_APP_BROWSER === "1";
const shots = process.env.OPENBOT_APP_SHOTS;

const APP = join(import.meta.dir, "..");
const ORIGIN = "http://openbot.test";
const WIDE = { width: 1024, height: 1000 };
const PHONE = { width: 390, height: 844 };
const THEMES = ["light", "dark"] as const;

async function bundle(): Promise<string> {
  const built = await Bun.build({
    entrypoints: [
      join(import.meta.dir, "workspace-snapshots-layout.fixture.tsx"),
    ],
    target: "browser",
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
  });
  if (!built.success) throw new AggregateError(built.logs, "bundle failed");
  const script = built.outputs.find((output) => output.kind === "entry-point");
  if (!script) throw new Error("bundle has no entry point");
  return script.text();
}

function packageDir(name: string): string {
  const dir = [
    join(APP, "node_modules", name),
    join(APP, "..", "node_modules", name),
  ].find(existsSync);
  if (!dir) throw new Error(`no package ${name}`);
  return dir;
}

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
if (asked) {
  script = await bundle();
  const { chromium } = await import("playwright-core");
  browser = await chromium.launch({ channel: "chromium" });
}

afterAll(async () => {
  await browser?.close();
});

/** Styles every class now on the page, and waits for transitions to finish. */
async function style(page: Page) {
  const classes = await page.evaluate(() =>
    [...document.querySelectorAll("[class]")].flatMap((element) => [
      ...element.classList,
    ]),
  );
  await page.addStyleTag({ content: await stylesheet(classes) });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(400);
  await page.waitForFunction(() =>
    document
      .getAnimations()
      .every((running) => !(running instanceof CSSTransition)),
  );
}

async function open(
  scene: string,
  theme: (typeof THEMES)[number],
  window: { width: number; height: number },
): Promise<Page> {
  const page = await browser.newPage({
    viewport: window,
    deviceScaleFactor: 2,
    colorScheme: theme,
  });
  page.on("pageerror", (error) => console.error(error));
  const inter = join(packageDir("@fontsource-variable/inter"), "files");
  await page.route(`${ORIGIN}/**`, (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/")
      return route.fulfill({
        contentType: "text/html",
        body: `<!doctype html><html lang="en"><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module" src="/copies.js"></script></body></html>`,
      });
    if (path === "/copies.js")
      return route.fulfill({ contentType: "text/javascript", body: script });
    const font = join(inter, path.split("/").pop() ?? "");
    if (path.startsWith("/files/") && existsSync(font))
      return route.fulfill({ path: font });
    return route.fulfill({ status: 404 });
  });
  await page.goto(`${ORIGIN}/?scene=${scene}&theme=${theme}`);
  await page
    .getByRole("heading", { name: "Saved copies" })
    .waitFor({ timeout: 10_000 });
  await style(page);
  return page;
}

async function shot(page: Page, name: string) {
  if (!shots) return;
  mkdirSync(shots, { recursive: true });
  await page.screenshot({ path: join(shots, `copies-${name}.png`) });
}

/** The page does not scroll sideways, and an open dialog is whole inside the window. */
async function fits(page: Page) {
  const sideways = await page.evaluate(
    () =>
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth,
  );
  expect(sideways).toBe(0);
  const viewport = page.viewportSize();
  for (const dialog of await page.getByRole("dialog").all()) {
    const box = await dialog.boundingBox();
    if (!box || !viewport) continue;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
    expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
  }
}

describe.skipIf(!asked)("a Bot's saved copies, drawn", () => {
  for (const theme of THEMES)
    for (const window of [WIDE, PHONE]) {
      const at = `${theme}-${window.width}`;

      test(`the list, confirming and a refusal, ${at}`, async () => {
        const page = await open("list", theme, window);
        try {
          await shot(page, `list-${at}`);
          await fits(page);
          await page.getByRole("button", { name: "Restore" }).nth(1).click();
          await page.getByRole("heading", { name: /^Restore from/ }).waitFor();
          await style(page);
          await shot(page, `confirm-${at}`);
          await fits(page);
          await page.getByRole("button", { name: "Restore it" }).click();
          await page.getByRole("dialog").getByRole("alert").waitFor();
          await style(page);
          await shot(page, `refused-${at}`);
          await fits(page);
        } finally {
          await page.close();
        }
      }, 60_000);

      for (const scene of ["running", "failed"])
        test(`a restore ${scene}, ${at}`, async () => {
          const page = await open(scene, theme, window);
          try {
            await shot(page, `${scene}-${at}`);
            await fits(page);
          } finally {
            await page.close();
          }
        }, 60_000);

      test(`an admin's dialog of another person's copies, ${at}`, async () => {
        const page = await open("admin", theme, window);
        try {
          await page
            .getByRole("button", { name: "Restore…" })
            .first()
            .waitFor();
          await style(page);
          await shot(page, `admin-${at}`);
          await fits(page);
          await page.getByRole("button", { name: "Restore…" }).first().click();
          await page
            .getByRole("heading", { name: "Dana Whitfield's computer" })
            .waitFor();
          await page
            .getByRole("dialog")
            .getByRole("button", { name: "Restore" })
            .first()
            .waitFor();
          await style(page);
          await shot(page, `admin-dialog-${at}`);
          await fits(page);
          await page
            .getByRole("dialog")
            .getByRole("button", { name: "Restore" })
            .first()
            .click();
          await page.getByRole("heading", { name: /^Restore from/ }).waitFor();
          await style(page);
          await shot(page, `admin-confirm-${at}`);
          await fits(page);
        } finally {
          await page.close();
        }
      }, 60_000);
    }
});
