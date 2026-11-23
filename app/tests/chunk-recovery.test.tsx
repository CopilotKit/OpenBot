import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Browser, BrowserType, Page, Route } from "playwright-core";
import { compile } from "tailwindcss";

/**
 * A part of the app that couldn't be fetched is fetched again, and a release that replaced the
 * page's build is loaded, never the router's dead "Something went wrong!".
 *
 * FOUND IN OPENBOT DESKTOP ON OPENBOT CLOUD. Back in a conversation after another one, the pane
 * showed the router's own error screen with WebKit's "Importing a module script failed.": a file of
 * the app's code was asked for after a release had replaced the build that named it, and the
 * OpenBot answered 404, as it does for a file it doesn't have. A part loaded with React's `lazy`
 * never tried again, and TanStack Router's own reload for a route's file happens once per message
 * per session, which in WebKit is the same message for every file.
 *
 * In a real browser, with the app's error screen around code split into files of its own, as the
 * build splits it (`chunk-recovery.fixture.tsx`). The test's server serves each build under its own
 * path and `/` names the build it serves now, as an OpenBot's `index.html` does. A release is the
 * server naming a new build and no longer serving the old one's files. In Chromium and in WebKit,
 * the engine OpenBot Desktop's Mac window draws with.
 *
 *   OPENBOT_APP_BROWSER=1 bun test app/tests/chunk-recovery.test.tsx
 *
 * Chromium by default; OPENBOT_APP_ENGINES=chromium,webkit adds WebKit, as CI runs it. With
 * OPENBOT_APP_SHOTS=<dir> the error screen is saved as chunk-recovery-<engine>-<theme>.png.
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
/** On https, as OpenBot Cloud is: the page is a secure context, so the clipboard is offered. */
const ORIGIN = "https://openbot.test";
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

/** The fixture and the files it was split into, by name, with which one is the entry. */
type Build = { entry: string; files: Map<string, string> };

async function bundle(): Promise<Build> {
  const built = await Bun.build({
    entrypoints: [join(import.meta.dir, "chunk-recovery.fixture.tsx")],
    target: "browser",
    splitting: true,
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
  const files = new Map<string, string>();
  let entry = "";
  for (const output of built.outputs) {
    const name = basename(output.path);
    if (!name.endsWith(".js")) continue;
    files.set(name, await output.text());
    if (output.kind === "entry-point") entry = name;
  }
  if (!entry) throw new Error("bundle has no entry point");
  return { entry, files };
}

/** The file a lazily loaded component was split into: the chunk that holds its words. */
function chunkHolding(build: Build, words: string): string {
  for (const [name, text] of build.files)
    if (name !== build.entry && text.includes(words)) return name;
  throw new Error(`no chunk holds ${words}`);
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
let build: Build;

beforeAll(async () => {
  if (!asked) return;
  build = await bundle();
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

/**
 * One OpenBot as the page sees it across releases. `build` is the one it serves now: `/` names it
 * and only its files are there, every other build's answer 404 that nothing may keep, as the
 * server's own routes answer a file they don't have. `askedBuild`, when set, is the build `/`
 * names when the page asks for it, while a page load still gets `build`: a cache in front of the
 * OpenBot that keeps handing out the old page. `refuse` answers 404 for a file, `refused` counts
 * each.
 */
type Server = {
  build: number;
  askedBuild?: number;
  refuse: (file: string) => boolean;
  refused: Map<string, number>;
  loads: number;
  /** How often the page asked which build is served, and whether that goes unanswered. */
  asked: number;
  unreachable?: boolean;
};

function server(): Server {
  return {
    build: 1,
    refuse: () => false,
    refused: new Map(),
    loads: 0,
    asked: 0,
  };
}

function html(buildNumber: number): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><script type="module" src="/build-${buildNumber}/${build.entry}"></script></head><body><div id="root"></div></body></html>`;
}

function answer(route: Route, state: Server) {
  const request = route.request();
  const where = new URL(request.url()).pathname;
  const file = /^\/build-(\d+)\/([^/]+)$/.exec(where);
  if (file) {
    const [, number, name] = file;
    const text = build.files.get(name);
    if (Number(number) !== state.build || !text || state.refuse(name)) {
      state.refused.set(name, (state.refused.get(name) ?? 0) + 1);
      return route.fulfill({
        status: 404,
        contentType: "text/plain",
        headers: { "cache-control": "no-store" },
        body: "Not found",
      });
    }
    return route.fulfill({ contentType: "text/javascript", body: text });
  }
  if (where.startsWith("/api/"))
    return route.fulfill({
      status: 404,
      json: { status: 404, detail: "Not found." },
      headers: { "content-type": "application/problem+json" },
    });
  const navigation = request.isNavigationRequest();
  if (navigation) state.loads += 1;
  else {
    state.asked += 1;
    // The OpenBot out of reach: the page's own question about its build gets no answer.
    if (state.unreachable) return route.abort("failed");
  }
  return route.fulfill({
    contentType: "text/html",
    headers: { "cache-control": "no-cache" },
    body: html(navigation ? state.build : (state.askedBuild ?? state.build)),
  });
}

async function open(
  engine: string,
  theme: Theme,
  state: Server,
  path = "/",
  desktop = false,
): Promise<Page> {
  const browser = browsers.get(engine);
  if (!browser) throw new Error(`no ${engine}`);
  const page = await browser.newPage({
    viewport: { width: 1000, height: 640 },
    colorScheme: theme,
    reducedMotion: "reduce",
  });
  // Chromium reads the clipboard back with leave to. WebKit writes on a press without asking.
  if (engine === "chromium")
    await page
      .context()
      .grantPermissions(["clipboard-read", "clipboard-write"], {
        origin: ORIGIN,
      });
  if (desktop)
    // OpenBot Desktop's window, as far as this screen asks it: its status, with the folder it
    // keeps its log in, and Open log folder, each call noted for the test.
    await page.addInitScript(() => {
      const calls: string[] = [];
      Object.assign(window, {
        __desktopCalls: calls,
        __TAURI_INTERNALS__: {
          transformCallback: () => 1,
          invoke: async (command: string) => {
            calls.push(command);
            if (command.endsWith("|status"))
              return {
                openbotRunning: true,
                openbotHeld: false,
                processes: [],
                containers: [],
                intelligenceStack: null,
                intelligenceContainers: [],
                engine: null,
                root: "/Applications/OpenBot.app",
                appPort: null,
                version: "1.4.0",
                build: "abc1234",
                logFolder: "/Users/someone/Library/Logs/OpenBot",
              };
            return null;
          },
        },
      });
    });
  const inter = join(packageDir("@fontsource-variable/inter"), "files");
  await page.route(`${ORIGIN}/**`, (route) => {
    const where = new URL(route.request().url()).pathname;
    const font = join(inter, where.split("/").pop() ?? "");
    if (where.startsWith("/files/") && existsSync(font))
      return route.fulfill({ path: font });
    return answer(route, state);
  });
  await page.goto(`${ORIGIN}${path}`);
  return page;
}

/** Go somewhere in the app as a person does, through its own links. */
async function go(page: Page, name: string) {
  await page
    .getByRole("navigation", { name: "Conversations" })
    .getByRole("link", { name, exact: true })
    .click();
}

/** The build the page in the window is, by its entry script. */
function pageBuildOf(page: Page): Promise<string | null> {
  return page.evaluate(
    () =>
      document
        .querySelector('script[type="module"][src]')
        ?.getAttribute("src")
        ?.split("/")[1] ?? null,
  );
}

/** Not the router's own error screen, and no error screen at all on a page that recovered. */
async function expectNoRouterError(page: Page, recovered = true) {
  const text = (await page.textContent("body")) ?? "";
  expect(text).not.toContain("Something went wrong!");
  expect(text).not.toContain("Show Error");
  expect(text).not.toContain("Hide Error");
  if (recovered) {
    expect(text).not.toContain("module script failed");
    expect(text).not.toContain("dynamically imported module");
    expect(text).not.toContain("This page didn't load");
  }
}

/** The engine's own words for an import whose file didn't load. */
const ENGINE_WORDS = {
  chromium: "TypeError: Failed to fetch dynamically imported module",
  webkit: "TypeError: Importing a module script failed.",
} as const;

/** Style the page for every class it draws now. */
async function style(page: Page) {
  const classes = await page.evaluate(() =>
    [...document.querySelectorAll("[class]")].flatMap((element) => [
      ...element.classList,
    ]),
  );
  await page.addStyleTag({ content: await stylesheet([...new Set(classes)]) });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(250);
}

describe.skipIf(!asked)("A part of the app that couldn't be fetched", () => {
  for (const engine of engines) {
    test(`after a release, a part of a page loads the new build, once, in ${engine}`, async () => {
      const state = server();
      const page = await open(engine, "light", state);
      try {
        await page.locator("[data-home]").waitFor();
        // A release: the OpenBot now serves build 2 and none of build 1's files.
        state.build = 2;
        await go(page, "Part");
        await page.locator('[data-loaded="part"]').waitFor({ timeout: 15_000 });
        expect(new URL(page.url()).pathname).toBe("/part");
        expect(await pageBuildOf(page)).toBe("build-2");
        expect(state.loads).toBe(2);
        await expectNoRouterError(page);
      } finally {
        await page.close();
      }
    }, 60_000);

    test(`a second release in the same window loads the newer build again, for a route, in ${engine}`, async () => {
      const state = server();
      const page = await open(engine, "light", state);
      try {
        await page.locator("[data-home]").waitFor();
        state.build = 2;
        await go(page, "Route A");
        await page
          .locator('[data-loaded="route-a"]')
          .waitFor({ timeout: 15_000 });
        expect(await pageBuildOf(page)).toBe("build-2");
        await go(page, "Home");
        await page.locator("[data-home]").waitFor();
        // Another release while the same window stays open.
        state.build = 3;
        await go(page, "Route B");
        await page
          .locator('[data-loaded="route-b"]')
          .waitFor({ timeout: 15_000 });
        expect(new URL(page.url()).pathname).toBe("/route-b");
        expect(await pageBuildOf(page)).toBe("build-3");
        expect(state.loads).toBe(3);
        await expectNoRouterError(page);
      } finally {
        await page.close();
      }
    }, 60_000);

    test(`a file that failed once, with no release, is fetched again, in ${engine}`, async () => {
      const state = server();
      const page = await open(engine, "light", state);
      try {
        await page.locator("[data-home]").waitFor();
        const part = chunkHolding(build, "The part");
        let failures = 0;
        state.refuse = (file) => file === part && failures++ === 0;
        await go(page, "Part");
        await page.locator('[data-loaded="part"]').waitFor({ timeout: 15_000 });
        expect(state.refused.get(part)).toBe(1);
        // The page loaded again, once: an import that failed is never fetched again in that page.
        expect(state.loads).toBe(2);
        await expectNoRouterError(page);
      } finally {
        await page.close();
      }
    }, 60_000);

    test(`with the OpenBot out of reach, the error screen shows and the page stays, in ${engine}`, async () => {
      const state = server();
      const page = await open(engine, "light", state);
      try {
        await page.locator("[data-home]").waitFor();
        state.unreachable = true;
        state.refuse = () => true;
        await go(page, "Part");
        await page
          .getByRole("heading", { name: "This page didn't load" })
          .waitFor({ timeout: 15_000 });
        // Asked three times over a few seconds, and never loaded away into "can't connect".
        expect(state.asked).toBe(3);
        expect(state.loads).toBe(1);
        await expectNoRouterError(page, false);
      } finally {
        await page.close();
      }
    }, 60_000);

    for (const theme of THEMES)
      test(`a file that stays missing shows OpenBot's error screen with Reload, never a loop, in ${engine}, ${theme}`, async () => {
        const state = server();
        const part = chunkHolding(build, "The part");
        state.refuse = (file) => file === part;
        const page = await open(engine, theme, state);
        try {
          await page.locator("[data-home]").waitFor();
          await go(page, "Part");
          const heading = page.getByRole("heading", {
            name: "This page didn't load",
          });
          await heading.waitFor({ timeout: 15_000 });
          await expectNoRouterError(page, false);
          expect(
            await page
              .getByText(
                "OpenBot couldn't download part of this page. Reload to try again.",
              )
              .isVisible(),
          ).toBe(true);
          // The details for a bug report: what failed, where, and on which build.
          const details =
            (await page.getByLabel("Error details").textContent()) ?? "";
          expect(details.startsWith(ENGINE_WORDS[engine as "chromium"])).toBe(
            true,
          );
          expect(details).toContain("Page: /part");
          expect(details).toContain(`(${build.entry})`);
          expect(details).toContain("Browser: ");
          // Loaded again once, failed the same way, and stayed: no loop.
          expect(state.loads).toBe(2);
          expect(state.refused.get(part)).toBe(2);
          // In the pane, beside the sidebar, which stays.
          expect(
            await page
              .getByRole("navigation", { name: "Conversations" })
              .isVisible(),
          ).toBe(true);
          if (shots) {
            await style(page);
            mkdirSync(shots, { recursive: true });
            await page.screenshot({
              path: join(shots, `chunk-recovery-${engine}-${theme}.png`),
            });
          }
          // Copy details puts the same words on the clipboard.
          await page.getByRole("button", { name: "Copy details" }).click();
          await page.getByRole("button", { name: "Copied" }).waitFor();
          if (engine === "chromium")
            expect(
              await page.evaluate(() => navigator.clipboard.readText()),
            ).toBe(details);
          // Reload loads the page again, and with the file back it draws.
          state.refuse = () => false;
          await page.getByRole("button", { name: "Reload" }).click();
          await page
            .locator('[data-loaded="part"]')
            .waitFor({ timeout: 15_000 });
          expect(state.loads).toBe(3);
        } finally {
          await page.close();
        }
      }, 60_000);

    for (const theme of THEMES)
      test(`in OpenBot Desktop's window the error screen offers its log folder, in ${engine}, ${theme}`, async () => {
        const state = server();
        const part = chunkHolding(build, "The part");
        state.refuse = (file) => file === part;
        const page = await open(engine, theme, state, "/", true);
        try {
          await page.locator("[data-home]").waitFor();
          await go(page, "Part");
          await page
            .getByRole("heading", { name: "This page didn't load" })
            .waitFor({ timeout: 15_000 });
          await page
            .getByText(
              "If it keeps happening, share these details and your logs when you ask for help.",
            )
            .waitFor();
          const details =
            (await page.getByLabel("Error details").textContent()) ?? "";
          expect(details).toContain("App: OpenBot Desktop 1.4.0 (abc1234)");
          if (shots) {
            await style(page);
            mkdirSync(shots, { recursive: true });
            await page.screenshot({
              path: join(
                shots,
                `chunk-recovery-desktop-${engine}-${theme}.png`,
              ),
            });
          }
          await page.getByRole("button", { name: "Open log folder" }).click();
          await page.waitForFunction(() =>
            (
              window as unknown as { __desktopCalls: string[] }
            ).__desktopCalls.some((call) => call.endsWith("|open_logs")),
          );
        } finally {
          await page.close();
        }
      }, 60_000);

    test(`a cache that keeps handing out the old build loads the page again only once, in ${engine}`, async () => {
      const state = server();
      const page = await open(engine, "light", state);
      try {
        await page.locator("[data-home]").waitFor();
        // A release, with a cache in front still handing every page load build 1, all but the
        // part's file, which it never held.
        state.askedBuild = 2;
        const part = chunkHolding(build, "The part");
        state.refuse = (file) => file === part;
        await go(page, "Part");
        await page
          .getByRole("heading", { name: "This page didn't load" })
          .waitFor({ timeout: 20_000 });
        expect(new URL(page.url()).pathname).toBe("/part");
        expect(state.loads).toBe(2);
        // And it stays put.
        await page.waitForTimeout(2_000);
        expect(state.loads).toBe(2);
        await expectNoRouterError(page, false);
      } finally {
        await page.close();
      }
    }, 60_000);
  }
});
