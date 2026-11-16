import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Browser, BrowserType, Page } from "playwright-core";
import { compile } from "tailwindcss";

/**
 * On the invitations page no row of the sidebar looks like the page that is open.
 *
 * Seen on Windows, in OpenBot Desktop and on the web: open the account menu on Bots, choose
 * Invitations, and on /invitations the sidebar's Bots row was still drawn as if it were the open
 * page. Nothing in the route tree marks it (this test checks that too, on the real tree); the menu
 * opens upwards over the rows above the account row, Invitations sits right over Bots, and when the
 * menu goes the pointer is left resting on Bots, whose hover fill is the same fill the open page
 * gets. So a row under a pointer that has not moved since a menu closed over it is not filled.
 *
 * The whole app, as main.tsx mounts it on app/src/routeTree.gen.ts, against a stand-in server
 * (sidebar-current-row.fixture.tsx), in a real Chromium and WebKit, where hover is the browser's
 * own. With the pointer moved afterwards, the row it is on fills as hover always did.
 *
 *   OPENBOT_APP_BROWSER=1 bun test app/tests/sidebar-current-row.test.tsx
 *
 * With OPENBOT_APP_SHOTS=<dir> it also saves the sidebar on /invitations in each browser.
 */
const asked = process.env.OPENBOT_APP_BROWSER === "1";
const shots = process.env.OPENBOT_APP_SHOTS;

const APP = join(import.meta.dir, "..");
const ORIGIN = "http://openbot.test";

async function bundle(): Promise<string> {
  const built = await Bun.build({
    entrypoints: [join(import.meta.dir, "sidebar-current-row.fixture.tsx")],
    target: "browser",
    // An optional map renderer a library loads only when asked to draw a map; not installed.
    external: ["maplibre-gl"],
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
    define: {
      "process.env.NODE_ENV": JSON.stringify("production"),
      "import.meta.env.DEV": "false",
      "import.meta.env.PROD": "true",
      "import.meta.env.MODE": JSON.stringify("production"),
    },
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

let script: string;
const browsers: Browser[] = [];

beforeAll(async () => {
  if (!asked) return;
  script = await bundle();
});

afterAll(async () => {
  await Promise.all(browsers.map((browser) => browser.close()));
});

/** Style the page for every class it has drawn so far, menus and dialogs included. */
async function style(page: Page) {
  const classes = await page.evaluate(() =>
    [...document.querySelectorAll("[class]")].flatMap((element) => [
      ...element.classList,
    ]),
  );
  await page.addStyleTag({ content: await stylesheet([...new Set(classes)]) });
}

async function open(engine: BrowserType, path: string): Promise<Page> {
  const browser =
    engine.name() === "chromium"
      ? // The CI job installs full Chromium without the headless shell.
        await engine.launch({ channel: "chromium" })
      : await engine.launch();
  browsers.push(browser);
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
  });
  page.on("pageerror", (error) => console.error(error));
  await page.route(`${ORIGIN}/**`, (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/app.js")
      return route.fulfill({ contentType: "text/javascript", body: script });
    if (url.pathname.includes("."))
      return route.fulfill({ status: 404, body: "" });
    return route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html lang="en" class="light"><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module" src="/app.js"></script></body></html>`,
    });
  });
  await page.goto(`${ORIGIN}${path}`, { waitUntil: "domcontentloaded" });
  return page;
}

/** What the sidebar's rows say about themselves, and the fill each is drawn with. */
async function rows(page: Page) {
  return page.evaluate(() => {
    const footer = document.querySelector("[data-sidebar=footer]");
    const links = [
      ...(footer?.querySelectorAll<HTMLAnchorElement>("a[href]") ?? []),
    ];
    return {
      marked: links
        .filter(
          (link) =>
            link.dataset.status === "active" ||
            link.getAttribute("aria-current") === "page",
        )
        .map((link) => link.textContent?.trim()),
      filled: links
        .filter((link) => {
          const fill = getComputedStyle(link).backgroundColor;
          return fill !== "rgba(0, 0, 0, 0)" && fill !== "transparent";
        })
        .map((link) => link.textContent?.trim()),
    };
  });
}

describe.skipIf(!asked)("the sidebar on the invitations page", () => {
  for (const name of ["chromium", "webkit"] as const) {
    test(`in ${name}, after choosing Invitations from the account menu on Bots, no row looks open`, async () => {
      const playwright = await import("playwright-core");
      const page = await open(playwright[name], "/bots");
      const account = page.getByRole("button", { name: /Dana Fresh/ });
      await account.waitFor();
      await style(page);
      await page.waitForFunction(() =>
        [...document.querySelectorAll("[data-sidebar=footer] a")].some(
          (link) => (link as HTMLElement).dataset.status === "active",
        ),
      );
      expect((await rows(page)).marked).toEqual(["Bots"]);

      await account.click();
      const entry = page.getByRole("menuitem", { name: /Invitations/ });
      await entry.waitFor();
      await style(page);
      const box = await entry.boundingBox();
      const bots = await page
        .locator("[data-sidebar=footer] a", { hasText: "Bots" })
        .boundingBox();
      // The premise: the menu opens over the rows above it, and Invitations sits over Bots.
      expect(box && bots).toBeTruthy();
      await entry.click();
      await page.waitForURL(`${ORIGIN}/invitations`);
      await page.getByRole("menu").waitFor({ state: "detached" });
      // A few frames for the browser to work out what is under the pointer now.
      await page.evaluate(
        () =>
          new Promise((done) =>
            requestAnimationFrame(() => requestAnimationFrame(done)),
          ),
      );
      await page.waitForTimeout(300);
      const pointerOn = await page.evaluate(
        ([x, y]) => document.elementFromPoint(x, y)?.closest("a")?.textContent,
        [
          (box?.x ?? 0) + (box?.width ?? 0) / 2,
          (box?.y ?? 0) + (box?.height ?? 0) / 2,
        ],
      );
      if (shots) {
        mkdirSync(shots, { recursive: true });
        await page.screenshot({
          path: join(shots, `sidebar-on-invitations-${name}.png`),
          clip: { x: 0, y: 0, width: 360, height: 900 },
        });
      }
      const unanswered = await page.evaluate(
        () => (window as unknown as { unanswered: string[] }).unanswered,
      );
      expect({ ...(await rows(page)), pointerOn, unanswered }).toMatchObject({
        marked: [],
        filled: [],
      });

      // The pointer moves: the row it is on fills, as hover always did.
      const botsNow = await page
        .locator("[data-sidebar=footer] a", { hasText: "Bots" })
        .boundingBox();
      await page.mouse.move(
        (botsNow?.x ?? 0) + 40,
        (botsNow?.y ?? 0) + (botsNow?.height ?? 0) / 2,
        { steps: 4 },
      );
      await page.waitForTimeout(100);
      expect((await rows(page)).filled).toEqual(["Bots"]);
    }, 120_000);
  }
});
