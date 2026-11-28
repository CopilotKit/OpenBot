import { afterAll, beforeAll, describe, expect } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Browser, BrowserType, Page } from "playwright-core";
import { compile } from "tailwindcss";
import { personBody } from "./accounts-api";
import { still } from "./page-still";
import { test } from "./renderer-crash";

/**
 * Settings → Computer offers the move to OpenBot Cloud inside OpenBot Desktop, with OpenBot on this
 * computer, in a desktop build that offers OpenBot Cloud (`moveToCloud` on the app's `connection`).
 *
 * In a real browser, Chromium and WebKit, light and dark, in the app's real settings frame: the
 * row sits first under Connection, its dialog says what happens before anything does, and Continue
 * asks the desktop app (`move_to_cloud`), which then shows setup at the move. Nothing is cut off or
 * pushed sideways, row or dialog.
 *
 *   OPENBOT_APP_BROWSER=1 OPENBOT_APP_ENGINES=chromium,webkit bun test app/tests/move-to-cloud-settings.test.tsx
 *
 * With OPENBOT_APP_SHOTS=<dir> each step is saved as move-to-cloud-settings-<step>-<engine>-<theme>.png.
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
const WINDOW = { width: 1280, height: 800 };
const THEMES = ["light", "dark"] as const;
type Theme = (typeof THEMES)[number];

/** What the page's server answers, as far as Settings → Computer asks it. */
function answer(path: string): { status: number; json: unknown } {
  if (path === `${ORGANIZATION}/people/me`)
    return {
      status: 200,
      json: {
        person: personBody({
          id: "sam",
          name: "Sam Rivera",
          email: "sam@example.com",
          role: "admin",
        }),
        openbotVersion: "v1.2.0",
      },
    };
  if (path === `${ORGANIZATION}/deployment`)
    return {
      status: 200,
      json: {
        generativeUi: true,
        selfHostBanner: false,
        localEvaluation: true,
        edition: "team",
        authProviders: [],
        ssoConfigured: false,
        ssoRequired: false,
      },
    };
  return { status: 404, json: { detail: "Not found." } };
}

/**
 * OpenBot Desktop, as the page meets it (`__TAURI_INTERNALS__`): OpenBot runs on this computer, and
 * the build offers OpenBot Cloud. Every command it is asked is kept in `__asked`.
 */
function desktopApp() {
  const asked: string[] = [];
  (window as unknown as Record<string, unknown>).__asked = asked;
  const status = {
    openbotRunning: true,
    openbotHeld: true,
    processes: [],
    containers: [],
    intelligenceStack: null,
    intelligenceContainers: [],
    engine: "podman",
    root: "/Users/sam/OpenBot",
    appPort: 3010,
    version: "1.2.0",
    build: "Built 2026-11-21 from main",
    logFolder: "/Users/sam/Library/Logs/ai.copilotkit.openbot.desktop",
  };
  const answers: Record<string, unknown> = {
    connection: { mode: "local", address: null, moveToCloud: true },
    status,
    update_offer: { version: null, current: "1.2.0", installing: null },
    usage_data: { shared: true, offByEnvironment: false },
    move_to_cloud: null,
  };
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
    transformCallback: () => 0,
    invoke: async (command: string) => {
      const name = command.replace("plugin:openbot-desktop|", "");
      asked.push(name);
      if (name in answers) return answers[name];
      throw `command ${command} not found`;
    },
  };
}

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
    entrypoints: [join(import.meta.dir, "move-to-cloud-settings.fixture.tsx")],
    target: "browser",
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
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

async function open(engine: string, theme: Theme): Promise<Page> {
  const browser = browsers.get(engine);
  if (!browser) throw new Error(`no ${engine}`);
  const page = await browser.newPage({
    viewport: WINDOW,
    colorScheme: theme,
    reducedMotion: "reduce",
  });
  page.on("pageerror", (error) => console.error(error));
  await page.addInitScript(desktopApp);
  const inter = join(packageDir("@fontsource-variable/inter"), "files");
  await page.route(`${ORIGIN}/**`, (route) => {
    const where = new URL(route.request().url()).pathname;
    if (where === "/screens.js")
      return route.fulfill({ contentType: "text/javascript", body: script });
    const font = join(inter, where.split("/").pop() ?? "");
    if (where.startsWith("/files/") && existsSync(font))
      return route.fulfill({ path: font });
    if (where.startsWith("/api/")) {
      const { status, json } = answer(where);
      return route.fulfill({ status, json });
    }
    return route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head><body><div id="root"></div><script type="module" src="/screens.js"></script></body></html>`,
    });
  });
  await page.goto(`${ORIGIN}/settings/computer`);
  return page;
}

/** Style the page for every class it draws now: what just opened brings classes of its own. */
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

async function shoot(page: Page, step: string, engine: string, theme: Theme) {
  await style(page);
  if (!shots) return;
  mkdirSync(shots, { recursive: true });
  await page.screenshot({
    path: join(shots, `move-to-cloud-settings-${step}-${engine}-${theme}.png`),
  });
}

/** What a person would see wrong: sideways scroll, a control cut off, the dialog off screen. */
async function measured(page: Page) {
  return page.evaluate(() => {
    const inside = (rect: DOMRect) =>
      rect.left >= -0.5 && rect.right <= innerWidth + 0.5;
    const dialog = document.querySelector("[data-slot=dialog-content]");
    const scope: Element = dialog ?? document.body;
    const cut = [...scope.querySelectorAll("button, a, input")]
      .filter((control) => {
        const rect = control.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      })
      .filter((control) => !control.matches("[data-sidebar=rail]"))
      .filter((control) => !inside(control.getBoundingClientRect()))
      .map(
        (control) =>
          control.textContent?.trim() ||
          control.getAttribute("aria-label") ||
          control.tagName,
      );
    const box = dialog?.getBoundingClientRect();
    return {
      sideways: document.documentElement.scrollWidth > innerWidth,
      cut,
      dialogInside: box
        ? inside(box) && box.top >= 0 && box.bottom <= innerHeight + 0.5
        : true,
    };
  });
}

const FINE = { sideways: false, cut: [], dialogInside: true };

describe.skipIf(!asked)("Move to OpenBot Cloud in Settings", () => {
  for (const engine of engines)
    for (const theme of THEMES)
      test(`the row opens a dialog that says what happens, and Continue asks the desktop app, in ${engine}, ${theme}`, async () => {
        const page = await open(engine, theme);
        try {
          const move = page.getByRole("button", {
            name: "Move to OpenBot Cloud",
          });
          await move.waitFor();
          await page
            .getByText("OpenBot runs on this computer", { exact: true })
            .waitFor();
          // Styled first, so the row is scrolled to where it is drawn.
          await style(page);
          await page.evaluate(() =>
            [...document.querySelectorAll("button")]
              .find((button) => button.textContent === "Move to OpenBot Cloud")
              ?.scrollIntoView({ block: "center" }),
          );
          await shoot(page, "row", engine, theme);
          expect(await measured(page)).toEqual(FINE);
          await move.click();
          const dialog = page.getByRole("dialog");
          await dialog
            .getByText("Move to OpenBot Cloud?", { exact: true })
            .waitFor();
          await shoot(page, "dialog", engine, theme);
          expect(await measured(page)).toEqual(FINE);
          expect(
            await page.evaluate(() =>
              (window as unknown as { __asked: string[] }).__asked.includes(
                "move_to_cloud",
              ),
            ),
          ).toBe(false);
          await dialog.getByRole("button", { name: "Continue" }).click();
          await page.waitForFunction(() =>
            (window as unknown as { __asked: string[] }).__asked.includes(
              "move_to_cloud",
            ),
          );
        } finally {
          await page.close();
        }
      }, 60_000);
});
