import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Browser, BrowserType } from "playwright-core";
import { compile } from "tailwindcss";
import { ATTACHMENT, FILE_NAME } from "./bot-file-links.data";
import { still } from "./page-still";

/**
 * A Bot's link to the file it sent downloads the file, in a real browser, and nothing in its words
 * reads "[blocked]".
 *
 * FOUND IN THE WEB APP: the deck's card downloaded fine, but the Bot's words under it said "Download
 * the presentation [blocked]", because it linked the file by its workspace path. Drawn here from the
 * real transcript, the app's tools and its stylesheet: the link is the stored file, a click on it is
 * a download of the deck, and a link to a draft the Bot never sent is its words and nothing more.
 *
 *   OPENBOT_APP_BROWSER=1 bun test app/tests/bot-file-links-browser.test.tsx
 *
 * Chromium by default, as CI has it. OPENBOT_APP_ENGINES=chromium,webkit adds WebKit. With
 * OPENBOT_APP_SHOTS=<dir> each page is saved as bot-file-links-<engine>-<theme>-<width>.png.
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
const WIDTHS = [390, 1440] as const;
const THEMES = ["light", "dark"] as const;
type Theme = (typeof THEMES)[number];
const FILE_READ = new RegExp(
  `^/api/v2/organizations/[^/]+/attachments/${ATTACHMENT}$`,
);
const DECK = Buffer.from("PK\u0003\u0004 a deck, as far as this test cares");

async function bundle(): Promise<string> {
  const built = await Bun.build({
    entrypoints: [join(import.meta.dir, "bot-file-links-browser.fixture.tsx")],
    target: "browser",
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
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

async function open(engine: string, theme: Theme, width: number) {
  const browser = browsers.get(engine);
  if (!browser) throw new Error(`no ${engine}`);
  const page = await browser.newPage({
    viewport: { width, height: 900 },
    colorScheme: theme,
    reducedMotion: "reduce",
    acceptDownloads: true,
  });
  page.on("pageerror", (error) => console.error(error));
  const inter = join(packageDir("@fontsource-variable/inter"), "files");
  await page.route(`${ORIGIN}/**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/transcript.js")
      return route.fulfill({ contentType: "text/javascript", body: script });
    const font = join(inter, path.split("/").pop() ?? "");
    if (path.startsWith("/files/") && existsSync(font))
      return route.fulfill({ path: font });
    // The stored deck, as the server serves an attachment: its type, and its name to save it as.
    if (FILE_READ.test(path))
      return route.fulfill({
        status: 200,
        headers: {
          "content-type":
            "application/vnd.openxmlformats-officedocument.presentationml.presentation",
          "content-disposition": `attachment; filename="${FILE_NAME}"`,
        },
        body: route.request().method() === "HEAD" ? "" : DECK,
      });
    if (path.startsWith("/api/"))
      return route.fulfill({ status: 404, json: { detail: "Not found." } });
    return route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html lang="en" class="${theme}" style="color-scheme: ${theme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head><body class="bg-background text-foreground"><div id="root"></div><script type="module" src="/transcript.js"></script></body></html>`,
    });
  });
  await page.goto(`${ORIGIN}/`);
  await page
    .locator(`figure[aria-label="File from the Bot: ${FILE_NAME}"]`)
    .waitFor({ timeout: 15_000 });
  await page.getByText("in case you want the longer version").waitFor();
  const classes = await page.evaluate(() =>
    [...document.querySelectorAll("[class]")].flatMap((element) => [
      ...element.classList,
    ]),
  );
  await page.addStyleTag({ content: await stylesheet([...new Set(classes)]) });
  await page.evaluate(() => document.fonts.ready);
  await still(page);
  return page;
}

describe.skipIf(!asked)("a Bot's link to the file it sent", () => {
  for (const engine of engines)
    for (const theme of THEMES)
      for (const width of WIDTHS)
        test(`downloads the file and never reads [blocked], in ${engine}, ${theme}, at ${width}px`, async () => {
          const page = await open(engine, theme, width);
          try {
            if (shots) {
              mkdirSync(shots, { recursive: true });
              await page.screenshot({
                path: join(
                  shots,
                  `bot-file-links-${engine}-${theme}-${width}.png`,
                ),
                fullPage: true,
              });
            }
            const reply = page.locator('[data-message-id="a2"]');
            expect(await reply.textContent()).not.toContain("[blocked]");
            // The draft it never sent is its words, not a link of any kind.
            expect(
              await reply
                .getByRole("link", { name: "the first draft" })
                .count(),
            ).toBe(0);
            // The deck it sent is a link to the stored file, and a click saves the deck, exactly as
            // the card's own Download does.
            const card = page.locator(
              `figure[aria-label="File from the Bot: ${FILE_NAME}"] a[aria-label="Download ${FILE_NAME}"]`,
            );
            const link = reply.getByRole("link", {
              name: "Download the presentation",
            });
            expect(await link.getAttribute("href")).toMatch(FILE_READ);
            expect(await link.getAttribute("href")).toBe(
              await card.getAttribute("href"),
            );
            expect(await link.getAttribute("download")).toBe(
              await card.getAttribute("download"),
            );
            for (const each of [card, link]) {
              if (engine === "chromium") {
                const [download] = await Promise.all([
                  page.waitForEvent("download"),
                  each.click(),
                ]);
                expect(download.suggestedFilename()).toBe(FILE_NAME);
              } else {
                /*
                 * Playwright's headless WebKit saves nothing from a click on a download link here,
                 * the card's own Download included, so in WebKit the link is held to being the
                 * card's link (above) and to a click keeping the conversation.
                 */
                await each.click();
              }
              // Still in the conversation: a download, never a page that replaces it.
              expect(new URL(page.url()).pathname).toBe("/");
            }
          } finally {
            await page.close();
          }
        }, 120_000);
});
