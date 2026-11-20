import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Browser, BrowserType, Page } from "playwright-core";
import { compile } from "tailwindcss";
import { apiTask, RESULTS, STATES, TITLES } from "./task-report-chip.data";

/**
 * A task shows once in the conversation that asked for it: its card, updated in place.
 *
 * FOUND ON THE DESKTOP: a delegated task showed twice. Its card ("Done", Open thread), and right
 * under it the result's own chip, the task's title again with a link into the same thread. The
 * chip says which task a result is about and leads into its thread, and directly under the task's
 * card the card already says both. A result that lands away from its card, after the person asked
 * something else, still leads with it: there the chip is the only thing saying which task it is.
 *
 * Drawn in a real browser from the real transcript, the Bot's `delegate` renderer and the app's
 * stylesheet, for a task in every state its card reads (Working, Needs you, Done, Couldn't finish,
 * Stopped), as the conversation draws when it is opened again.
 *
 *   OPENBOT_APP_BROWSER=1 bun test app/tests/task-report-chip.test.tsx
 *
 * Chromium by default, as CI has it. OPENBOT_APP_ENGINES=chromium,webkit adds WebKit. With
 * OPENBOT_APP_SHOTS=<dir> each page is saved as task-report-chip-<engine>-<theme>-<width>.png.
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
const TASK_READ = /^\/api\/v2\/organizations\/[^/]+\/tasks\/task-([a-z]+)$/;

async function bundle(): Promise<string> {
  const built = await Bun.build({
    entrypoints: [join(import.meta.dir, "task-report-chip.fixture.tsx")],
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
    // Tall enough for the whole conversation, so a screenshot holds every task.
    viewport: { width, height: width < 600 ? 4200 : 2600 },
    colorScheme: theme,
    reducedMotion: "reduce",
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
    const read = TASK_READ.exec(path);
    if (read && route.request().method() === "GET")
      return route.fulfill({
        json: { task: apiTask(read[1] as Parameters<typeof apiTask>[0]) },
      });
    if (path.startsWith("/api/"))
      return route.fulfill({ status: 404, json: { detail: "Not found." } });
    return route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html lang="en" class="${theme}" style="color-scheme: ${theme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head><body class="bg-background text-foreground"><div id="root"></div><script type="module" src="/transcript.js"></script></body></html>`,
    });
  });
  await page.goto(`${ORIGIN}/`);
  // Every result is drawn, and every card reads its task as it stands.
  for (const words of Object.values(RESULTS))
    await page.getByText(words).first().waitFor({ timeout: 15_000 });
  for (const state of STATES)
    await page
      .locator(
        `[data-slot=task-card][data-state=${state}][aria-label="Task: ${TITLES[state]}"]`,
      )
      .waitFor({ timeout: 15_000 });
  const classes = await page.evaluate(() =>
    [...document.querySelectorAll("[class]")].flatMap((element) => [
      ...element.classList,
    ]),
  );
  await page.addStyleTag({ content: await stylesheet([...new Set(classes)]) });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(300);
  return page;
}

/** One task as the conversation draws it: its card, its result, and every way into its thread. */
async function look(page: Page, id: keyof typeof TITLES) {
  return page.evaluate(
    ({ title, words, channel }) => {
      const card = document.querySelector(
        `[data-slot=task-card][aria-label="Task: ${title}"]`,
      );
      const report = [
        ...document.querySelectorAll("[data-slot=task-report]"),
      ].find((element) => element.textContent?.includes(words));
      const into = (root: Element | null | undefined) =>
        root
          ? root.querySelectorAll(`a[href="/channel/${channel}"]`).length
          : -1;
      const named = [...document.querySelectorAll("body *")].filter(
        (element) =>
          element.children.length === 0 &&
          element.textContent?.trim() === title,
      ).length;
      const cardBox = card?.getBoundingClientRect();
      const reportBox = report?.getBoundingClientRect();
      return {
        card: Boolean(card),
        report: Boolean(report),
        /** Ways into the thread on the result itself. */
        intoFromReport: into(report),
        /** Ways into the thread on the card. */
        intoFromCard: into(card),
        /** How many times the task's title is written on the page. */
        named,
        /** The result starts below its card, never on it. */
        belowCard:
          cardBox && reportBox ? reportBox.top >= cardBox.bottom - 0.5 : false,
        /** The result fits the window. */
        inside: reportBox
          ? reportBox.left >= -0.5 && reportBox.right <= innerWidth + 0.5
          : false,
      };
    },
    {
      title: TITLES[id],
      words: RESULTS[id],
      channel: `c-${id}`,
    },
  );
}

describe.skipIf(!asked)("a delegated task in its conversation", () => {
  for (const engine of engines)
    for (const theme of THEMES)
      for (const width of WIDTHS)
        test(`shows once, as its card, in ${engine}, ${theme}, at ${width}px`, async () => {
          const page = await open(engine, theme, width);
          try {
            if (shots) {
              mkdirSync(shots, { recursive: true });
              await page.screenshot({
                path: join(
                  shots,
                  `task-report-chip-${engine}-${theme}-${width}.png`,
                ),
                fullPage: true,
              });
            }
            for (const state of STATES)
              expect({ state, ...(await look(page, state)) }).toEqual({
                state,
                card: true,
                report: true,
                // The card is the way in, and the title is said once, on it.
                intoFromReport: 0,
                intoFromCard: 1,
                named: 1,
                belowCard: true,
                inside: true,
              });
            // Away from its card, the result still says which task it is, and leads into it.
            expect(await look(page, "away")).toEqual({
              card: true,
              report: true,
              intoFromReport: 1,
              intoFromCard: 1,
              named: 2,
              belowCard: true,
              inside: true,
            });
          } finally {
            await page.close();
          }
        }, 120_000);
});
