import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
  Browser,
  BrowserContextOptions,
  BrowserType,
  Page,
} from "playwright-core";
import { compile } from "tailwindcss";

/**
 * Return on a phone's keyboard starts a new line, and only the send button sends.
 *
 * Reported from OpenBot in a phone's browser: pressing Return in the message box sent the message,
 * half-written. On a touch keyboard Return sits under Backspace and is how a person starts a new
 * line. A computer keeps Enter to send and Shift+Enter for a new line, and the Enter that confirms a
 * character an input method is composing never sends; WebKit sends that one after
 * `compositionend` with the key code 229, and it used to send the message on a Mac.
 *
 * Drawn in a real browser with a phone's touch screen (an iPhone's in WebKit, an Android phone's in
 * Chromium) and with a computer's mouse, because whether a finger is the only pointer is the
 * browser's to say. The composer is the real component, bundled from the fixture beside this file,
 * with the app's stylesheet. The person types with the keyboard and taps or clicks Send.
 *
 *   OPENBOT_APP_BROWSER=1 bun test app/tests/composer-touch-return.test.tsx
 *
 * Chromium by default. OPENBOT_APP_ENGINES=chromium,webkit adds WebKit. With
 * OPENBOT_APP_SHOTS=<dir> each box is saved, holding two lines, as
 * composer-touch-return-<engine>-<device>-<layout>.png.
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
const LAYOUTS = ["thread", "home"] as const;

async function bundle(): Promise<string> {
  const built = await Bun.build({
    entrypoints: [join(import.meta.dir, "composer-touch-return.fixture.tsx")],
    target: "browser",
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
  });
  if (!built.success) throw new AggregateError(built.logs, "bundle failed");
  const script = built.outputs.find((output) => output.kind === "entry-point");
  if (!script) throw new Error("bundle has no entry point");
  return script.text();
}

/** Where `@import "<package>[/<file>]"` lands, by the package's `style` export as Vite reads it. */
function packageStylesheet(id: string): string {
  const parts = id.split("/");
  const name = id.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
  const dir = [
    join(APP, "node_modules", name),
    join(APP, "..", "node_modules", name),
  ].find(existsSync);
  if (!dir) throw new Error(`no package for ${id}`);
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
const devices: Record<string, Record<string, BrowserContextOptions>> = {};

beforeAll(async () => {
  if (!asked) return;
  script = await bundle();
  const playwright = await import("playwright-core");
  /** A device's screen, touch and pointer, in whichever engine draws it. */
  const profile = (name: string): BrowserContextOptions => {
    const { defaultBrowserType: _, ...options } = playwright.devices[name];
    return options;
  };
  for (const engine of engines) {
    const type: BrowserType = playwright[engine];
    browsers.set(
      engine,
      // The CI job installs full Chromium without the headless shell.
      await type.launch(engine === "chromium" ? { channel: "chromium" } : {}),
    );
    devices[engine] = {
      phone: profile(engine === "webkit" ? "iPhone 15" : "Pixel 7"),
      computer: { viewport: { width: 1280, height: 800 } },
    };
  }
}, 120_000);

afterAll(async () => {
  for (const browser of browsers.values()) await browser.close();
});

async function open(
  engine: "chromium" | "webkit",
  device: "phone" | "computer",
  layout: (typeof LAYOUTS)[number],
): Promise<Page> {
  const browser = browsers.get(engine);
  if (!browser) throw new Error(`no ${engine}`);
  const page = await browser.newPage({
    ...devices[engine][device],
    reducedMotion: "reduce",
  });
  page.on("pageerror", (error) => console.error(error));
  await page.route(`${ORIGIN}/**`, (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/composer.js")
      return route.fulfill({ contentType: "text/javascript", body: script });
    if (path === "/")
      return route.fulfill({
        contentType: "text/html",
        body: '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head><body><div id="root"></div><script type="module" src="/composer.js"></script></body></html>',
      });
    return route.fulfill({ status: 404 });
  });
  await page.goto(`${ORIGIN}/?layout=${layout}`);
  await editor(page).waitFor();
  const classes = await page.evaluate(() => [
    ...new Set(
      [...document.querySelectorAll("[class]")].flatMap((element) => [
        ...element.classList,
      ]),
    ),
  ]);
  await page.addStyleTag({ content: await stylesheet(classes) });
  return page;
}

const editor = (page: Page) => page.getByRole("textbox", { name: "Message" });
const sent = (page: Page) => page.evaluate(() => window.sent);
const typed = (page: Page) =>
  editor(page).evaluate((box) => (box as HTMLElement).innerText);

/** Tapped on a touch screen, clicked with a mouse. */
async function press(page: Page, device: "phone" | "computer", name: string) {
  const target = page.getByRole("button", { name });
  if (device === "phone") await target.tap();
  else await target.click();
}

async function focus(page: Page, device: "phone" | "computer") {
  if (device === "phone") await editor(page).tap();
  else await editor(page).click();
}

/** Long enough for a send the key started to have reached `onSubmit`. */
const settle = (page: Page) => page.waitForTimeout(150);

describe.skipIf(!asked)("Return in the message box", () => {
  for (const engine of engines)
    for (const layout of LAYOUTS) {
      test(`on a phone starts a new line, and Send sends both lines, in ${engine} (${layout})`, async () => {
        const page = await open(engine, "phone", layout);
        try {
          // A finger is the only pointer: this is the phone the report came from.
          expect(
            await page.evaluate(
              () =>
                matchMedia("(pointer: coarse)").matches &&
                !matchMedia("(any-pointer: fine)").matches,
            ),
          ).toBe(true);
          await focus(page, "phone");
          await page.keyboard.type("Pick up milk");
          await page.keyboard.press("Enter");
          await page.keyboard.type("and eggs");
          await settle(page);

          expect(await sent(page)).toEqual([]);
          expect((await typed(page)).split("\n").filter(Boolean)).toEqual([
            "Pick up milk",
            "and eggs",
          ]);
          if (shots) {
            mkdirSync(shots, { recursive: true });
            await page.screenshot({
              path: join(
                shots,
                `composer-touch-return-${engine}-phone-${layout}.png`,
              ),
            });
          }

          await press(page, "phone", "Send message");
          await settle(page);
          expect(await sent(page)).toEqual(["Pick up milk\nand eggs"]);
          expect((await typed(page)).trim()).toBe("");
        } finally {
          await page.close();
        }
      }, 60_000);

      test(`on a phone with a keyboard attached, Cmd or Ctrl+Enter still sends, in ${engine} (${layout})`, async () => {
        const page = await open(engine, "phone", layout);
        try {
          await focus(page, "phone");
          await page.keyboard.type("Sent from the keyboard");
          await page.keyboard.press("ControlOrMeta+Enter");
          await settle(page);
          expect(await sent(page)).toEqual(["Sent from the keyboard"]);
        } finally {
          await page.close();
        }
      }, 60_000);

      test(`on a computer Enter sends and Shift+Enter starts a new line, in ${engine} (${layout})`, async () => {
        const page = await open(engine, "computer", layout);
        try {
          await focus(page, "computer");
          await page.keyboard.type("First line");
          await page.keyboard.press("Shift+Enter");
          await page.keyboard.type("second line");
          await settle(page);
          expect(await sent(page)).toEqual([]);
          if (shots) {
            mkdirSync(shots, { recursive: true });
            await page.screenshot({
              path: join(
                shots,
                `composer-touch-return-${engine}-computer-${layout}.png`,
              ),
            });
          }

          await page.keyboard.press("Enter");
          await settle(page);
          expect(await sent(page)).toEqual(["First line\nsecond line"]);
          expect((await typed(page)).trim()).toBe("");
        } finally {
          await page.close();
        }
      }, 60_000);

      test(`on a computer the Enter that confirms a composed character never sends, in ${engine} (${layout})`, async () => {
        const page = await open(engine, "computer", layout);
        try {
          await focus(page, "computer");
          await page.keyboard.type("こんにちは");
          // As Chromium sends it, marked composing, and as WebKit sends it, after the composition
          // ended, with the key code 229.
          await editor(page).evaluate((box) => {
            box.dispatchEvent(
              new KeyboardEvent("keydown", {
                key: "Enter",
                isComposing: true,
                keyCode: 229,
                bubbles: true,
                cancelable: true,
              }),
            );
            box.dispatchEvent(
              new KeyboardEvent("keydown", {
                key: "Enter",
                keyCode: 229,
                bubbles: true,
                cancelable: true,
              }),
            );
          });
          await settle(page);
          expect(await sent(page)).toEqual([]);
          expect(await typed(page)).toContain("こんにちは");

          // The next Enter is an ordinary one, and sends.
          await page.keyboard.press("Enter");
          await settle(page);
          expect(await sent(page)).toEqual(["こんにちは"]);
        } finally {
          await page.close();
        }
      }, 60_000);
    }
});
