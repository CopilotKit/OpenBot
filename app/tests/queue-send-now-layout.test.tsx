import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Browser, BrowserType, Page } from "playwright-core";
import { compile } from "tailwindcss";

/**
 * Send now on a queued message, in a real browser.
 *
 * A person types to a Bot that is mid-turn, so the message is parked as Queued under the reply so
 * far. Its footer offers Send now beside Remove, drawn the same way: the same line, size and muted
 * colour. Pressed, the turn is stopped and the message reads "Up next"; when the turn ends it is
 * sent on its own, the reply so far stays, and another message queued beside it stays queued until
 * that turn is over. queue-send-now.test.tsx holds the behaviour; this drives it with a real
 * keyboard and mouse in the app's stylesheet, in a wide window and a phone-width one.
 *
 *   OPENBOT_APP_BROWSER=1 bun test app/tests/queue-send-now-layout.test.tsx
 *
 * Chromium by default, as CI has it. OPENBOT_APP_ENGINES=chromium,webkit adds WebKit. With
 * OPENBOT_APP_SHOTS=<dir> each step is saved as queue-send-now-<step>-<engine>-<theme>-<width>.png.
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
const FIRST = "After that, tell me which crate was heaviest.";
const SECOND =
  "Stop weighing. List the crates you have already weighed, with each weight.";

/** The fixture bundled for the browser. `@/lib/marks` is Vite's `import.meta.glob`, so no marks. */
async function bundle(): Promise<string> {
  const built = await Bun.build({
    entrypoints: [join(import.meta.dir, "queue-send-now-layout.fixture.tsx")],
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

/** The conversation, mid-turn. */
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
    // Nothing on the side reaches a server here.
    if (path.startsWith("/api/")) return route.fulfill({ status: 404 });
    return route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html lang="en" class="${theme}" style="color-scheme: ${theme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head><body><div id="root"></div><script type="module" src="/conversation.js"></script></body></html>`,
    });
  });
  await page.goto(`${ORIGIN}/?theme=${theme}`);
  await page.getByText("Weighing crate 4 next.").waitFor({ timeout: 15_000 });
  await style(page);
  await page.evaluate(() => document.fonts.ready);
  return page;
}

/** Type a message while the Bot works, and queue it, as a person does. */
async function queue(page: Page, text: string) {
  await page.getByRole("textbox", { name: "Message" }).click();
  await page.keyboard.type(text);
  await page.getByRole("button", { name: "Queue message" }).click();
  await page
    .getByRole("button", { name: `Remove queued message: ${text}` })
    .waitFor();
}

async function shoot(page: Page, step: string, name: string) {
  if (!shots) return;
  mkdirSync(shots, { recursive: true });
  await page.screenshot({
    path: join(shots, `queue-send-now-${step}-${name}.png`),
  });
}

/** How a queued line's footer is drawn: its status and its two buttons. */
function footerOf(page: Page, text: string) {
  return page
    .getByRole("button", { name: `Send queued message now: ${text}` })
    .evaluate((element) => {
      const sendNow = element as HTMLElement;
      const footer = sendNow.parentElement as HTMLElement;
      const status = footer.querySelector('[role="status"]') as HTMLElement;
      const remove = [...footer.querySelectorAll("button")].find(
        (button) => button.textContent === "Remove",
      ) as HTMLElement;
      const box = (element: HTMLElement) => element.getBoundingClientRect();
      const look = (element: HTMLElement) => {
        const style = getComputedStyle(element);
        return {
          size: style.fontSize,
          color: style.color,
          weight: style.fontWeight,
        };
      };
      const middle = (element: HTMLElement) =>
        box(element).top + box(element).height / 2;
      return {
        oneLine:
          Math.abs(middle(sendNow) - middle(status)) <= 1 &&
          Math.abs(middle(remove) - middle(status)) <= 1,
        order:
          box(status).right <= box(sendNow).left &&
          box(sendNow).right <= box(remove).left,
        sendNowLooksLikeRemove:
          JSON.stringify(look(sendNow)) === JSON.stringify(look(remove)),
        mutedLikeStatus: look(sendNow).color === look(status).color,
        inside: box(remove).right <= innerWidth && box(status).left >= 0,
        sideways: document.documentElement.scrollWidth > innerWidth,
      };
    });
}

/** What the fixture page keeps for the test: the Stops pressed, what was sent, the turn's end. */
type Fixture = Window & {
  __stops: number;
  __sent: string[];
  __endTurn: () => void;
};
const stops = (page: Page) =>
  page.evaluate(() => (window as unknown as Fixture).__stops);
const sent = (page: Page) =>
  page.evaluate(() => (window as unknown as Fixture).__sent);
const endTurn = (page: Page) =>
  page.evaluate(() => (window as unknown as Fixture).__endTurn());

describe.skipIf(!asked)("Send now on a queued message", () => {
  for (const engine of engines)
    for (const theme of ["light", "dark"] as const)
      for (const window of [
        { width: 1000, height: 760 },
        { width: 390, height: 760 },
      ])
        test(`stops the turn and sends that message next, in ${engine}, ${theme}, ${window.width}px`, async () => {
          const page = await open(engine, theme, window);
          const name = `${engine}-${theme}-${window.width}`;
          try {
            await queue(page, FIRST);
            await queue(page, SECOND);
            await style(page);
            await shoot(page, "queued", name);
            expect(await footerOf(page, SECOND)).toEqual({
              oneLine: true,
              order: true,
              sendNowLooksLikeRemove: true,
              mutedLikeStatus: true,
              inside: true,
              sideways: false,
            });

            // By keyboard, as a person who does not use a mouse would.
            await page
              .getByRole("button", {
                name: `Send queued message now: ${SECOND}`,
              })
              .focus();
            await page.keyboard.press("Enter");
            await page.getByText("Up next", { exact: true }).waitFor();
            await style(page);
            await shoot(page, "up-next", name);
            expect(await stops(page)).toBe(1);
            expect(await sent(page)).toEqual([]);

            // The stopped turn ends: that message goes alone, and the reply so far stays.
            await endTurn(page);
            await page
              .getByRole("button", {
                name: `Remove queued message: ${SECOND}`,
              })
              .waitFor({ state: "detached" });
            expect(await sent(page)).toEqual([SECOND]);
            expect(
              await page.getByText("Weighing crate 4 next.").isVisible(),
            ).toBe(true);
            expect(
              await page
                .getByRole("button", {
                  name: `Remove queued message: ${FIRST}`,
                })
                .isVisible(),
            ).toBe(true);
            await style(page);
            await shoot(page, "sent-now", name);

            // That turn ends, and the one still queued goes after it.
            await endTurn(page);
            await page
              .getByRole("button", {
                name: `Remove queued message: ${FIRST}`,
              })
              .waitFor({ state: "detached" });
            expect(await sent(page)).toEqual([SECOND, FIRST]);
          } finally {
            await page.close();
          }
        }, 90_000);
});
