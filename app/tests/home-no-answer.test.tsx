import { afterAll, beforeAll, describe, expect } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Browser, BrowserType, Page, Route } from "playwright-core";
import { compile } from "tailwindcss";
import { still } from "./page-still";
import { test } from "./renderer-crash";

/**
 * A message sent from home when OpenBot doesn't answer.
 *
 * FOUND IN OPENBOT DESKTOP, moving to OpenBot Cloud: "hello world" sent from home got no answer, and
 * the line under the composer said "Load failed", the Mac window's own words for a request that got
 * none ("Failed to fetch" in Chromium). Every screen that showed a failed request's message showed
 * the browser's words the same way. Now the request says OpenBot's sentence.
 *
 * In a real browser, through the app's own home route, composer and start sequence: the message is
 * routed to a Bot, and the request that creates its conversation is failed at the network, as a
 * server that went away fails it. Home takes the words back and says under the composer what
 * happened, in OpenBot's words, in Chromium and in WebKit, the engine the Mac window draws with.
 *
 *   OPENBOT_APP_BROWSER=1 bun test app/tests/home-no-answer.test.tsx
 *
 * Chromium by default; OPENBOT_APP_ENGINES=chromium,webkit adds WebKit, as CI runs it. With
 * OPENBOT_APP_SHOTS=<dir> the screen is saved as home-no-answer-<engine>-<theme>.png, light and dark.
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
const ORGANIZATION = "/api/v2/organizations/default";
const CONVERSATIONS = `${ORGANIZATION}/conversations`;
const ROUTE = `${CONVERSATIONS}/route`;
const THEMES = ["light", "dark"] as const;
type Theme = (typeof THEMES)[number];

/** The vendored marks as data URIs, as Vite's `import.meta.glob` hands them to `@/lib/marks`. */
function marksModule(): string {
  const dir = join(APP, "..", "shared", "marks");
  const marks = Object.fromEntries(
    readdirSync(dir)
      .filter((file) => file.endsWith(".svg"))
      .map((file) => [
        file.replace(".svg", ""),
        `data:image/svg+xml;base64,${readFileSync(join(dir, file)).toString("base64")}`,
      ]),
  );
  return `const marks = ${JSON.stringify(marks)}; export const markFor = (id) => (id && marks[id]) || null;`;
}

async function bundle(): Promise<string> {
  const built = await Bun.build({
    entrypoints: [join(import.meta.dir, "home-no-answer.fixture.tsx")],
    target: "browser",
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    // The chat loads a map library only when a Bot draws a map. Nothing here does.
    external: ["maplibre-gl"],
    plugins: [
      {
        name: "marks",
        setup(build) {
          build.onResolve({ filter: /^@\/lib\/marks$/ }, () => ({
            path: "marks",
            namespace: "marks",
          }));
          build.onLoad({ filter: /.*/, namespace: "marks" }, () => ({
            contents: marksModule(),
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

/** What the server was asked, and what never reached it. */
type Trail = { routed: number; unanswered: number };

/**
 * One OpenBot's server, as far as home asks it: the message is routed to the Bot, and the request
 * that creates its conversation never gets an answer. The home page's other reads, which this is
 * not about, are the API's plain not found.
 */
function answer(route: Route, trail: Trail) {
  const request = route.request();
  const path = new URL(request.url()).pathname;
  if (path === ROUTE && request.method() === "POST") {
    trail.routed += 1;
    return route.fulfill({
      json: {
        botId: "terra-bot",
        name: "Terra Bot",
        reason: "matched",
        fallback: false,
        viaMention: false,
      },
    });
  }
  if (path === CONVERSATIONS && request.method() === "POST") {
    trail.unanswered += 1;
    return route.abort("failed");
  }
  return route.fulfill({
    status: 404,
    json: { status: 404, detail: "Not found." },
    headers: { "content-type": "application/problem+json" },
  });
}

async function open(engine: string, theme: Theme, trail: Trail): Promise<Page> {
  const browser = browsers.get(engine);
  if (!browser) throw new Error(`no ${engine}`);
  const page = await browser.newPage({
    viewport: { width: 1280, height: 800 },
    colorScheme: theme,
    reducedMotion: "reduce",
  });
  page.on("pageerror", (error) => console.error(error));
  const inter = join(packageDir("@fontsource-variable/inter"), "files");
  await page.route(`${ORIGIN}/**`, (route) => {
    const where = new URL(route.request().url()).pathname;
    if (where === "/screens.js")
      return route.fulfill({ contentType: "text/javascript", body: script });
    const font = join(inter, where.split("/").pop() ?? "");
    if (where.startsWith("/files/") && existsSync(font))
      return route.fulfill({ path: font });
    if (where.startsWith("/api/")) return answer(route, trail);
    return route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head><body><div id="root"></div><script type="module" src="/screens.js"></script></body></html>`,
    });
  });
  await page.goto(`${ORIGIN}/`);
  return page;
}

/** Style the page for every class it draws now. */
async function style(page: Page) {
  const classes = await page.evaluate(() =>
    [...document.querySelectorAll("[class]")].flatMap((element) => [
      ...element.classList,
    ]),
  );
  await page.addStyleTag({ content: await stylesheet([...new Set(classes)]) });
  await page.evaluate(() => document.fonts.ready);
  await still(page);
}

/** Write in home's composer and send, as a person does. */
async function send(page: Page, text: string) {
  const box = page.getByRole("textbox", { name: "Message" });
  await box.click();
  await page.keyboard.type(text);
  await page.keyboard.press("Enter");
}

describe.skipIf(!asked)("A message sent from home that gets no answer", () => {
  for (const engine of engines)
    for (const theme of THEMES)
      test(`says so in OpenBot's words, never the browser's, in ${engine}, ${theme}`, async () => {
        const trail: Trail = { routed: 0, unanswered: 0 };
        const page = await open(engine, theme, trail);
        try {
          await send(page, "hello world");
          const line = page.getByRole("alert");
          await line.waitFor();
          // Back home, with the words back in the box to send again.
          expect(new URL(page.url()).pathname).toBe("/");
          expect(
            await page.getByRole("textbox", { name: "Message" }).textContent(),
          ).toBe("hello world");
          expect(trail).toEqual({ routed: 1, unanswered: 1 });
          if (shots) {
            await style(page);
            mkdirSync(shots, { recursive: true });
            await page.screenshot({
              path: join(shots, `home-no-answer-${engine}-${theme}.png`),
            });
          }
          const said = await line.textContent();
          expect(said).not.toContain("Load failed");
          expect(said).not.toContain("Failed to fetch");
          expect(said).toBe(
            "Couldn't reach OpenBot. Check your connection and try again.",
          );
        } finally {
          await page.close();
        }
      }, 60_000);
});
