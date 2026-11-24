import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { BotBrowserApiState } from "@openbot/shared/bot-browser";
import type {
  Browser,
  BrowserType,
  Page,
  WebSocketRoute,
} from "playwright-core";
import { compile } from "tailwindcss";

/**
 * A Bot's screen is sharp on a high-resolution display.
 *
 * Seen dogfooding on a Retina Mac: the Bot's page in the full-size view looked soft beside everything
 * else in the window. The computer sent every frame at the page's own 1280x800, and the browser drew
 * each of its pixels as four or more. Now the screen tells the computer how large it is drawn, in the
 * device's own pixels, and the computer sends frames that size. The frame's `width` and `height` stay
 * the page's own 1280x800, which is what a click is measured in, so a click still lands where the
 * person sees it land.
 *
 * Rendered in a real browser at a device pixel ratio of 2, because how large the screen is drawn and
 * how many pixels that is are the browser's to decide. The view is the real `ComputerView`, opened
 * full size, with the app's stylesheet, bundled from bot-screen-record-layout.fixture.tsx. The test is
 * the computer at the other end of the screen's socket: it says hello, and answers each size it is
 * told with a JPEG of a page that really is that size, made by the same browser.
 *
 *   OPENBOT_APP_BROWSER=1 bun test app/tests/bot-screen-sharp.test.tsx
 *
 * Chromium by default. OPENBOT_APP_ENGINES=chromium,webkit adds WebKit, the engine the Mac window
 * draws with, as CI runs it. With OPENBOT_APP_SHOTS=<dir> it saves the full-size view as
 * bot-screen-sharp-<engine>.png.
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

/** The page's own size, as the computer's browser lays it out, and what every frame message says. */
const PAGE = { width: 1280, height: 800 } as const;
/** The most the computer sends, whatever it is told. */
const LARGEST = { width: 2560, height: 1600 } as const;

/** A button on the Bot's page, in the page's own pixels, painted a colour nothing else on it is. */
const TARGET = { left: 880, top: 480, width: 240, height: 120 } as const;

/** The Bot's page: a heading, some words, and the target. */
const COMPUTER_PAGE = `<!doctype html><html><body style="margin:0;background:#fff;color:#111;font:18px/1.5 sans-serif">
<h1 style="margin:64px 96px 0;font-size:44px">Example Domain</h1>
<p style="margin:16px 96px;max-width:720px">This domain is for use in documentation examples without needing permission. Small print like this is what looked soft.</p>
<div aria-label="Continue" style="position:absolute;left:${TARGET.left}px;top:${TARGET.top}px;width:${TARGET.width}px;height:${TARGET.height}px;background:#ff0000"></div>
</body></html>`;

/** A 1x1 PNG: the picture the Computer draws until the live screen connects. */
const PIXEL =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

/** The Bot's browser, open on one page (`botBrowserApiPaths.state`). */
const BROWSER_STATE: BotBrowserApiState = {
  open: true,
  tabs: [
    {
      id: "tab-1",
      url: "https://example.com/",
      title: "Example Domain",
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

/** The Bot's page as a JPEG `width` pixels wide, drawn by the browser at the scale that makes it so. */
const pictures = new Map<string, string>();
async function picture(engine: string, width: number): Promise<string> {
  const key = `${engine}-${width}`;
  const kept = pictures.get(key);
  if (kept) return kept;
  const browser = browsers.get(engine);
  if (!browser) throw new Error(`no ${engine}`);
  const context = await browser.newContext({
    viewport: PAGE,
    deviceScaleFactor: width / PAGE.width,
  });
  try {
    const page = await context.newPage();
    await page.setContent(COMPUTER_PAGE);
    const jpeg = await page.screenshot({ type: "jpeg", quality: 90 });
    const base64 = jpeg.toString("base64");
    pictures.set(key, base64);
    return base64;
  } finally {
    await context.close();
  }
}

type Sent = { type: string; [field: string]: unknown };

/**
 * The computer at the other end of the screen's socket.
 *
 * It says `hello` once the test lets it, sends a frame at the page's own size as a computer does
 * before it knows better, and answers each view size with a frame that many pixels wide, never more
 * than the largest it sends. Every frame message says the page's own 1280x800.
 */
function computer(
  engine: string,
  hello: Record<string, unknown>,
  ready: Promise<void>,
) {
  const sent: Sent[] = [];
  // In the order they were asked for, as a stream is: a picture that takes longer to make never
  // overtakes the one after it.
  let queue = Promise.resolve();
  const frame = (socket: WebSocketRoute, width: number) => {
    const made = picture(engine, width);
    queue = queue.then(async () =>
      socket.send(JSON.stringify({ type: "frame", data: await made, ...PAGE })),
    );
    return queue;
  };
  const serve = async (socket: WebSocketRoute) => {
    socket.onMessage((message) => {
      const parsed = JSON.parse(String(message)) as Sent;
      sent.push(parsed);
      if (parsed.type !== "view-size") return;
      const scale = Math.min(
        1,
        LARGEST.width / Number(parsed.width),
        LARGEST.height / Number(parsed.height),
      );
      void frame(socket, Math.round(Number(parsed.width) * scale));
    });
    await ready;
    socket.send(JSON.stringify({ type: "hello", ...hello }));
    await frame(socket, PAGE.width);
  };
  return { sent, serve };
}

/** The Bot's screen, opened full size at a device pixel ratio of 2, with `holder` holding control. */
async function open(
  engine: string,
  window: { width: number; height: number },
  holder: "human" | "bot",
  hello: Record<string, unknown>,
) {
  const browser = browsers.get(engine);
  if (!browser) throw new Error(`no ${engine}`);
  const context = await browser.newContext({
    viewport: window,
    deviceScaleFactor: 2,
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => console.error(error));
  const inter = join(packageDir("@fontsource-variable/inter"), "files");
  let styled = () => {};
  const ready = new Promise<void>((resolve) => {
    styled = resolve;
  });
  const screen = computer(engine, hello, ready);
  await page.routeWebSocket(/\/screen$/, (socket) => {
    void screen.serve(socket);
  });
  await page.route(`${ORIGIN}/**`, (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/")
      return route.fulfill({
        contentType: "text/html",
        body: `<!doctype html><html lang="en" class="light"><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module" src="/view.js"></script></body></html>`,
      });
    if (path === "/view.js")
      return route.fulfill({ contentType: "text/javascript", body: script });
    const font = join(inter, path.split("/").pop() ?? "");
    if (path.startsWith("/files/") && existsSync(font))
      return route.fulfill({ path: font });
    const computerPath = `/api/v2/organizations/default/computers/${BOT}`;
    if (path === `${computerPath}/screenshot`)
      return route.fulfill({
        json: {
          base64: PIXEL,
          ...PAGE,
          capturedAt: new Date(0).toISOString(),
          url: "https://example.com/",
          title: "Example Domain",
        },
      });
    if (path === computerPath)
      return route.fulfill({ json: { botId: BOT, state: "ready" } });
    if (path === `${computerPath}/control`)
      return route.fulfill({
        json: { holder, since: new Date(0).toISOString(), requested: false },
      });
    if (path === `${computerPath}/browser`)
      return route.fulfill({ json: BROWSER_STATE });
    return route.fulfill({ status: 404, json: { error: "not found" } });
  });
  await page.goto(`${ORIGIN}/`);
  await page
    .getByRole("button", { name: "Open the Bot's screen full size" })
    .click();
  await page
    .getByRole("dialog", { name: "The Bot's screen" })
    .locator("canvas")
    .waitFor();
  const classes = await page.evaluate(() =>
    [...document.querySelectorAll("[class]")].flatMap((element) => [
      ...element.classList,
    ]),
  );
  await page.addStyleTag({ content: await stylesheet([...new Set(classes)]) });
  await page.evaluate(() => document.fonts.ready);
  // The computer says hello to a screen laid out as the app lays it out, as it is in the app.
  styled();
  return { page, sent: screen.sent, close: () => context.close() };
}

/** How large the screen is drawn on the page, and how many pixels its canvas holds. */
function measured(page: Page) {
  return page.evaluate(() => {
    const canvas = document.querySelector(
      '[aria-label="The Bot\'s screen"] canvas',
    ) as HTMLCanvasElement;
    const rect = canvas.getBoundingClientRect();
    return {
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height,
      pixels: canvas.width,
      ratio: window.devicePixelRatio,
    };
  });
}

/** The colour of the canvas's own pixel under a point of the Bot's page. */
function colourAt(page: Page, point: { x: number; y: number }) {
  return page.evaluate(
    (at) => {
      const canvas = document.querySelector(
        '[aria-label="The Bot\'s screen"] canvas',
      ) as HTMLCanvasElement;
      const data = canvas
        .getContext("2d")
        ?.getImageData(
          Math.floor((at.x * canvas.width) / at.pageWidth),
          Math.floor((at.y * canvas.height) / at.pageHeight),
          1,
          1,
        ).data;
      return data ? [data[0], data[1], data[2]] : null;
    },
    {
      ...point,
      pageWidth: PAGE.width,
      pageHeight: PAGE.height,
    },
  );
}

/** Whether `check` comes true within `timeout`, asked every 50ms. */
async function settles(
  check: () => boolean | Promise<boolean>,
  timeout = 10_000,
): Promise<boolean> {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    if (await check()) return true;
    await Bun.sleep(50);
  }
  return check();
}

const viewSizes = (sent: Sent[]) =>
  sent.filter((message) => message.type === "view-size") as {
    type: "view-size";
    width: number;
    height: number;
  }[];

/** Whether the last size the screen sent is the one it is drawn at now, in device pixels. */
async function toldItsSize(page: Page, sent: Sent[]): Promise<boolean> {
  const last = viewSizes(sent).at(-1);
  if (!last) return false;
  const at = await measured(page);
  return Math.abs(last.width - at.width * 2) <= 1;
}

/** Whether the canvas holds at least a pixel for each of the display's, across its width. */
async function sharp(page: Page): Promise<boolean> {
  const at = await measured(page);
  return at.pixels >= Math.round(at.width * 2) - 2;
}

describe.skipIf(!asked)("A Bot's screen on a high-resolution display", () => {
  for (const engine of engines) {
    test(`is drawn with a pixel for each of the display's, and a click lands where it is seen, in ${engine}`, async () => {
      const { page, sent, close } = await open(
        engine,
        { width: 1440, height: 900 },
        "human",
        { confirmFrames: true, viewSize: true },
      );
      try {
        // (a) The computer is told how large the screen is drawn, in the display's own pixels.
        expect(await settles(() => toldItsSize(page, sent))).toBe(true);
        const at = await measured(page);
        expect(at.ratio).toBe(2);
        const told = viewSizes(sent).at(-1);
        expect(told?.width).toBe(Math.round(at.width * 2));
        expect(
          Math.abs(
            (told?.height ?? 0) -
              Math.round(((told?.width ?? 0) * PAGE.height) / PAGE.width),
          ),
        ).toBeLessThanOrEqual(1);

        // (b) And the picture it answers with is drawn whole: the canvas holds that many pixels.
        expect(await settles(() => sharp(page))).toBe(true);
        if (shots) {
          mkdirSync(shots, { recursive: true });
          await page.screenshot({
            path: join(shots, `bot-screen-sharp-${engine}.png`),
          });
        }

        // (c) The target is drawn where the page has it, and a real click on it lands on it there.
        const middle = {
          x: TARGET.left + TARGET.width / 2,
          y: TARGET.top + TARGET.height / 2,
        };
        const [red, green, blue] = (await colourAt(page, middle)) ?? [];
        expect(red).toBeGreaterThan(200);
        expect(green).toBeLessThan(60);
        expect(blue).toBeLessThan(60);
        const shown = await measured(page);
        await page.mouse.click(
          shown.left + (middle.x * shown.width) / PAGE.width,
          shown.top + (middle.y * shown.height) / PAGE.height,
        );
        expect(
          await settles(
            () =>
              sent.filter(
                (message) =>
                  message.type === "mouse" && message.event === "released",
              ).length > 0,
          ),
        ).toBe(true);
        const clicks = sent.filter(
          (message) =>
            message.type === "mouse" &&
            (message.event === "pressed" || message.event === "released"),
        );
        expect(clicks.map((message) => message.event)).toEqual([
          "pressed",
          "released",
        ]);
        for (const click of clicks) {
          expect(Number(click.x)).toBeGreaterThanOrEqual(TARGET.left);
          expect(Number(click.x)).toBeLessThanOrEqual(
            TARGET.left + TARGET.width,
          );
          expect(Number(click.y)).toBeGreaterThanOrEqual(TARGET.top);
          expect(Number(click.y)).toBeLessThanOrEqual(
            TARGET.top + TARGET.height,
          );
        }

        // (e) A narrower window draws the screen smaller, and the computer is told the new size.
        const before = viewSizes(sent).length;
        await page.setViewportSize({ width: 1100, height: 800 });
        expect(
          await settles(
            async () =>
              viewSizes(sent).length > before &&
              (await toldItsSize(page, sent)),
          ),
        ).toBe(true);
        const narrower = await measured(page);
        expect(narrower.width).toBeLessThan(at.width);
        expect(viewSizes(sent).at(-1)?.width).toBe(
          Math.round(narrower.width * 2),
        );
        expect(await settles(() => sharp(page))).toBe(true);
      } finally {
        await close();
      }
    }, 60_000);

    test(`is sharp for a person only watching the Bot work, in ${engine}`, async () => {
      const { page, sent, close } = await open(
        engine,
        { width: 1440, height: 900 },
        "bot",
        { confirmFrames: true, viewSize: true },
      );
      try {
        expect(await settles(() => toldItsSize(page, sent))).toBe(true);
        expect(await settles(() => sharp(page))).toBe(true);
      } finally {
        await close();
      }
    }, 60_000);

    test(`is never told to a computer that has not said it takes a size, in ${engine}`, async () => {
      // A computer from before this answers a message it does not know with an input error, which
      // the screen would show.
      const { page, sent, close } = await open(
        engine,
        { width: 1440, height: 900 },
        "human",
        { confirmFrames: true },
      );
      try {
        expect(
          await settles(async () => (await measured(page)).pixels === 1280),
        ).toBe(true);
        await page.setViewportSize({ width: 1100, height: 800 });
        await Bun.sleep(600);
        expect(viewSizes(sent)).toEqual([]);
        // It goes on drawing the frames it is sent, confirming each as before.
        expect(sent.some((message) => message.type === "frame-received")).toBe(
          true,
        );
        expect((await measured(page)).pixels).toBe(1280);
      } finally {
        await close();
      }
    }, 60_000);
  }
});
