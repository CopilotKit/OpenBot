import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Browser, BrowserType, Page } from "playwright-core";
import { compile } from "tailwindcss";
import { APPS_PATH } from "./apps-api";
import { APP_ACCESS_REQUESTS_PATH } from "./bot-grants-api";
import { myConnectionPath } from "./connections-api";

/**
 * OpenBot Cloud's Connections, in a real browser: find an app from Connections, add and connect it,
 * or ask an admin for it, and remove it from its own page, without opening Admin.
 *
 * Reported by the admin of their own organization: Connections listed only the apps already added,
 * its search filtered only those, and the directory and the switch that removes an app were only in
 * Admin. team-connections-directory.test.tsx and connections-app-remove.test.tsx hold the behaviour;
 * this drives the real pages with a real mouse in the app's stylesheet, as an admin and as a member,
 * and looks at each step.
 *
 *   OPENBOT_APP_BROWSER=1 bun test app/tests/team-connections-directory-layout.test.tsx
 *
 * Chromium by default, as CI has it. OPENBOT_APP_ENGINES=chromium,webkit adds WebKit. With
 * OPENBOT_APP_SHOTS=<dir> each step is saved as <step>-<engine>-<theme>.png.
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

/** The fixture bundled for the browser. `@/lib/marks` is Vite's `import.meta.glob`, so no marks. */
async function bundle(): Promise<string> {
  const built = await Bun.build({
    entrypoints: [
      join(import.meta.dir, "team-connections-directory-layout.fixture.tsx"),
    ],
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
  await page.evaluate(() => document.fonts.ready);
}

/** The fixture at `path`, as `role`, in a window the width of a desktop app. */
async function open(
  engine: string,
  theme: "light" | "dark",
  role: "admin" | "member",
  path: string,
): Promise<Page> {
  const browser = browsers.get(engine);
  if (!browser) throw new Error(`no ${engine}`);
  const page = await browser.newPage({
    viewport: { width: 1000, height: 760 },
    colorScheme: theme,
    reducedMotion: "reduce",
  });
  page.on("pageerror", (error) => console.error(error));
  const inter = join(packageDir("@fontsource-variable/inter"), "files");
  await page.route(`${ORIGIN}/**`, (route) => {
    const at = new URL(route.request().url()).pathname;
    if (at === "/connections.js")
      return route.fulfill({ contentType: "text/javascript", body: script });
    const font = join(inter, at.split("/").pop() ?? "");
    if (at.startsWith("/files/") && existsSync(font))
      return route.fulfill({ path: font });
    // The fixture answers the API itself; anything that reaches the network has nowhere to go.
    if (at.startsWith("/api/")) return route.fulfill({ status: 404 });
    return route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html lang="en" class="${theme}" style="color-scheme: ${theme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head><body><div id="root"></div><script type="module" src="/connections.js"></script></body></html>`,
    });
  });
  await page.goto(`${ORIGIN}${path}?theme=${theme}&role=${role}`);
  return page;
}

async function shoot(page: Page, step: string, name: string) {
  if (!shots) return;
  await style(page);
  mkdirSync(shots, { recursive: true });
  await page.screenshot({ path: join(shots, `${step}-${name}.png`) });
}

/** Nothing runs off the side of the page, and every tile sits inside the page's column. */
function fits(page: Page) {
  return page.evaluate(() => {
    const column = document
      .querySelector("[data-slot=page-header]")
      ?.parentElement?.getBoundingClientRect();
    const tiles = [
      ...document.querySelectorAll(
        "[data-testid^=directory-], [data-testid^=account-]",
      ),
    ];
    return {
      sideways: document.documentElement.scrollWidth > innerWidth,
      inside:
        column !== undefined &&
        tiles.every((tile) => {
          const box = tile.getBoundingClientRect();
          return box.left >= column.left - 1 && box.right <= column.right + 1;
        }),
    };
  });
}

const events = (page: Page) =>
  page.evaluate(() => (window as unknown as { __events: string[] }).__events);

async function search(page: Page, term: string) {
  await page.getByRole("textbox", { name: "Search connections" }).fill(term);
}

describe.skipIf(!asked)("Connections on OpenBot Cloud", () => {
  for (const engine of engines)
    for (const theme of ["light", "dark"] as const) {
      const name = `${engine}-${theme}`;

      test(`an admin finds an app nobody added and adds and connects it in one press, in ${engine}, ${theme}`, async () => {
        const page = await open(engine, theme, "admin", "/connections");
        try {
          const browse = page.getByTestId("account-browse");
          await browse.waitFor({ timeout: 15_000 });
          await style(page);
          await shoot(page, "admin-connections", name);
          expect(await browse.innerText()).toContain("Browse apps");
          expect(await browse.getAttribute("href")).toBe(
            "/connections/browse/composio",
          );

          await search(page, "slack");
          const slack = page.getByTestId("directory-slack");
          await slack.waitFor({ timeout: 15_000 });
          await style(page);
          await shoot(page, "admin-search", name);
          expect(await slack.innerText()).toContain("Connect");
          expect(await fits(page)).toEqual({ sideways: false, inside: true });

          await slack.click();
          await page
            .getByText("Finish signing in to Slack in the tab that opened.")
            .waitFor({ timeout: 15_000 });
          await shoot(page, "admin-signing-in", name);
          const done = await events(page);
          expect(done.slice(0, 3)).toEqual([
            "tab claimed",
            `POST ${APPS_PATH}`,
            `POST ${myConnectionPath("composio-slack", "connect")}`,
          ]);
          expect(done.some((event) => event.startsWith("tab to "))).toBe(true);
        } finally {
          await page.close();
        }
      }, 90_000);

      test(`an admin removes an app from its own Connections page with Admin's switch, in ${engine}, ${theme}`, async () => {
        const page = await open(
          engine,
          theme,
          "admin",
          "/connections/composio-rootly",
        );
        try {
          const row = page.getByTestId("organization-app-switch");
          await row.waitFor({ timeout: 15_000 });
          await style(page);
          await shoot(page, "admin-app-page", name);
          expect(await row.innerText()).toContain(
            "Enable for this organization",
          );
          expect(await row.innerText()).toContain(
            "Turning this off removes it and every Bot's access to its tools.",
          );
          await row.getByRole("switch").click();
          await page.waitForURL(`${ORIGIN}/connections`, { timeout: 15_000 });
          // The one write the switch makes (the page's own account check aside).
          expect(
            (await events(page)).filter((event) => !event.endsWith("/confirm")),
          ).toEqual([`DELETE ${APPS_PATH}/composio-rootly`]);
          await page.getByTestId("account-browse").waitFor({ timeout: 15_000 });
          expect(
            await page.getByTestId("account-composio-rootly").count(),
          ).toBe(0);
          await shoot(page, "admin-removed", name);
        } finally {
          await page.close();
        }
      }, 90_000);

      test(`a member finds an app and asks an admin for it in one press, and gets no switch, in ${engine}, ${theme}`, async () => {
        const page = await open(engine, theme, "member", "/connections");
        try {
          const browse = page.getByTestId("account-browse");
          await browse.waitFor({ timeout: 15_000 });
          expect(await browse.innerText()).toContain("ask an admin");
          await search(page, "linear");
          const linear = page.getByTestId("directory-linear");
          await linear.waitFor({ timeout: 15_000 });
          expect(await linear.innerText()).toContain("Request");
          await linear.click();
          await page
            .getByTestId("directory-linear")
            .getByText("Requested")
            .waitFor({ timeout: 15_000 });
          await style(page);
          await shoot(page, "member-requested", name);
          expect(await events(page)).toEqual([
            `POST ${APP_ACCESS_REQUESTS_PATH}`,
          ]);
          expect(await fits(page)).toEqual({ sideways: false, inside: true });
          // A tile asked for is a plain tile, never a faded, disabled button.
          const faded = await page
            .getByTestId("directory-linear")
            .evaluate((tile) => Number(getComputedStyle(tile).opacity));
          expect(faded).toBe(1);

          await page.goto(
            `${ORIGIN}/connections/composio-rootly?theme=${theme}&role=member`,
          );
          await page.getByText("Your account").waitFor({ timeout: 15_000 });
          expect(
            await page.getByTestId("organization-app-switch").count(),
          ).toBe(0);
        } finally {
          await page.close();
        }
      }, 90_000);
    }
});
