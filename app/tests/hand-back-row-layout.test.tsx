import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { BotBrowserApiState } from "@openbot/shared/bot-browser";
import type { Browser, BrowserType, Page } from "playwright-core";
import { compile } from "tailwindcss";
import { still } from "./page-still";

/**
 * The row with Hand back, in a Bot's full-size screen taken over from a phone.
 *
 * Found in the end-to-end run at 390 wide: the person took control from the conversation, and under the Bot's page
 * the line beside Hand back read "You have control. Click and type on t…", the reason the Bot handed over the wheel
 * cut off with it, and a tall blank band sat between the page and that row. The sentence now wraps, and the row sits
 * right under the page. A wide window keeps the wheel in its column beside the page.
 *
 * Rendered in a real browser, because where a line breaks and how tall a column of flexible boxes comes out are the
 * browser's to decide. The view is the real `ComputerView` (bot-screen-record-layout.fixture.tsx), opened full size,
 * with the app's stylesheet. The server's answers are served to it as routes: a person holding the wheel the Bot handed
 * them, on a sign-in page that asks for a code.
 *
 *   OPENBOT_APP_BROWSER=1 bun test app/tests/hand-back-row-layout.test.tsx
 *
 * Chromium by default, as CI has it. OPENBOT_APP_ENGINES=chromium,webkit adds WebKit. With OPENBOT_APP_SHOTS=<dir>
 * each is saved as hand-back-row-<engine>-<theme>-<width>.png.
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
const BOT = "fernhill-guide";
const REASON = "This page is asking for a code sent to your phone.";
const SAID = `You have control. Click and type on the page. ${REASON}`;

/** A 1x1 PNG: the picture the Computer draws until the live screen connects. */
const PIXEL =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

/** The Bot's browser while the person drives it, as the server answers for them. */
const HELD = {
  open: true,
  tabs: [
    {
      id: "tab-1",
      url: "https://fernhill.example/members",
      title: "Members sign in",
      active: true,
    },
  ],
  recorder: {
    connected: false,
    phase: "idle",
    actions: 0,
    narration: "external",
  },
  mine: true,
  recordingIsMine: false,
} as BotBrowserApiState;

/** The wheel, with the person: the Bot asked them to take over, and they did. */
const TAKEN = {
  holder: "human",
  since: new Date(0).toISOString(),
  requested: false,
  transitioning: false,
  resumeSnapshotRequired: false,
  recoveryRequired: false,
  reason: REASON,
  request: {
    id: "request-1",
    reason: REASON,
    source: "model",
    status: "taken",
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    expiresAt: new Date(600_000).toISOString(),
  },
};

async function bundle(): Promise<string> {
  const built = await Bun.build({
    entrypoints: [
      join(import.meta.dir, "bot-screen-record-layout.fixture.tsx"),
    ],
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

/** The Bot's screen, opened full size in a window this size by a person who holds the wheel. */
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
  // The live screen's socket connects and sends no frame: the page keeps its shape without one.
  await page.routeWebSocket(/.*/, () => {});
  await page.route(`${ORIGIN}/**`, (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/")
      return route.fulfill({
        contentType: "text/html",
        body: `<!doctype html><html lang="en" class="${theme}" style="color-scheme: ${theme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head><body><div id="root"></div><script type="module" src="/view.js"></script></body></html>`,
      });
    if (path === "/view.js")
      return route.fulfill({ contentType: "text/javascript", body: script });
    const font = join(inter, path.split("/").pop() ?? "");
    if (path.startsWith("/files/") && existsSync(font))
      return route.fulfill({ path: font });
    const computer = `/api/v2/organizations/default/computers/${BOT}`;
    if (path === `${computer}/screenshot`)
      return route.fulfill({
        json: {
          base64: PIXEL,
          width: 1280,
          height: 800,
          capturedAt: new Date(0).toISOString(),
          url: "https://fernhill.example/members",
          title: "Members sign in",
        },
      });
    if (path === computer)
      return route.fulfill({ json: { botId: BOT, state: "ready" } });
    if (path === `${computer}/control`) return route.fulfill({ json: TAKEN });
    if (path === `${computer}/browser`) return route.fulfill({ json: HELD });
    return route.fulfill({ status: 404, json: { error: "not found" } });
  });
  await page.goto(`${ORIGIN}/`);
  await page
    .getByRole("button", { name: "Open the Bot's screen full size" })
    .click();
  const view = page.getByRole("dialog", { name: "The Bot's screen" });
  await view.getByRole("button", { name: "Hand back" }).waitFor();
  await view.getByRole("button", { name: "Record", exact: true }).waitFor();
  const classes = await page.evaluate(() =>
    [...document.querySelectorAll("[class]")].flatMap((element) => [
      ...element.classList,
    ]),
  );
  await page.addStyleTag({ content: await stylesheet([...new Set(classes)]) });
  await page.evaluate(() => document.fonts.ready);
  // The page is sized to the space it is given once that space has been measured (`useFittedWidth`).
  await still(page);
  return page;
}

/** The line beside Hand back, the Bot's page and the row, as the window draws them. */
async function measured(page: Page, said: string) {
  return page.evaluate((text) => {
    const view = document.querySelector(
      '[aria-label="The Bot\'s screen"]',
    ) as HTMLElement;
    const line = [...view.querySelectorAll("span")].find(
      (span) => span.textContent?.trim() === text,
    );
    const handBack = [...view.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Hand back",
    );
    // The browser window around the Bot's page, the space it is given, and the card that holds them.
    const screen = view.querySelector('[style*="aspect-ratio"]');
    const frame = screen?.closest(".overflow-clip") as HTMLElement | null;
    const space = frame?.parentElement;
    const card = space?.parentElement;
    const wheel = space?.nextElementSibling;
    if (!line || !handBack || !frame || !space || !card || !wheel) return null;
    const lineBox = line.getBoundingClientRect();
    return {
      window: { width: innerWidth, height: innerHeight },
      // Cut short: the text is wider than the box it is drawn in.
      clipped: line.scrollWidth > line.clientWidth + 1,
      line: {
        left: Math.round(lineBox.left),
        right: Math.round(lineBox.right),
      },
      handBack: {
        left: Math.round(handBack.getBoundingClientRect().left),
        right: Math.round(handBack.getBoundingClientRect().right),
      },
      frame: {
        bottom: Math.round(frame.getBoundingClientRect().bottom),
        right: Math.round(frame.getBoundingClientRect().right),
      },
      wheel: {
        top: Math.round(wheel.getBoundingClientRect().top),
        left: Math.round(wheel.getBoundingClientRect().left),
      },
      // The card's own gap between the space and the wheel's column.
      gap: Number.parseFloat(getComputedStyle(card).rowGap) || 0,
    };
  }, said);
}

async function shoot(page: Page, name: string) {
  if (!shots) return;
  mkdirSync(shots, { recursive: true });
  await page.screenshot({ path: join(shots, `${name}.png`) });
}

describe.skipIf(!asked)("the row with Hand back", () => {
  for (const engine of engines)
    for (const theme of ["light", "dark"] as const) {
      test(`on a phone says its whole sentence and sits right under the Bot's page, in ${engine}, ${theme}`, async () => {
        const page = await open(engine, theme, { width: 390, height: 844 });
        try {
          await shoot(page, `hand-back-row-${engine}-${theme}-390`);
          const at = await measured(page, SAID);
          expect(at).not.toBeNull();
          if (!at) return;
          expect({
            // The whole sentence, the Bot's reason with it: none of it cut off.
            clipped: at.clipped,
            // No blank band: the row starts the card's own gap under the Bot's browser, and no further (a pixel's
            // rounding aside).
            blankUnderPage: Math.max(
              0,
              at.wheel.top - at.frame.bottom - at.gap - 1,
            ),
          }).toEqual({ clipped: false, blankUnderPage: 0 });
          // Wrapped inside the window, beside Hand back.
          expect(at.line.left).toBeGreaterThanOrEqual(0);
          expect(at.line.right).toBeLessThanOrEqual(at.handBack.left);
          expect(at.handBack.right).toBeLessThanOrEqual(at.window.width);
        } finally {
          await page.close();
        }
      }, 60_000);

      test(`in a wide window stays in its column beside the Bot's page, in ${engine}, ${theme}`, async () => {
        const page = await open(engine, theme, { width: 1440, height: 900 });
        try {
          await shoot(page, `hand-back-row-${engine}-${theme}-1440`);
          const at = await measured(page, SAID);
          expect(at).not.toBeNull();
          if (!at) return;
          expect(at.clipped).toBe(false);
          expect(at.wheel.left).toBeGreaterThan(at.frame.right);
        } finally {
          await page.close();
        }
      }, 60_000);
    }
});
