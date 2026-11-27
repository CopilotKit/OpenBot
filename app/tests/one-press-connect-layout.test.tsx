import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Browser, BrowserType, Page } from "playwright-core";
import { compile } from "tailwindcss";
import { botAppPath } from "./bot-grants-api";
import { myConnectionPath } from "./connections-api";

/**
 * One Connect on the chat card, in a real browser, for an app nobody has turned on.
 *
 * A Bot asked for Fireflies, which connects with a key somebody types, or for Slack, which signs in
 * but says so only once it is on. The card said Turn on, and once pressed it swapped to a second
 * Connect. Now the card's one Connect turns the app on and goes straight on: Fireflies to the app's
 * page under Connections with the key form already open, Slack to its sign-in in a tab claimed on
 * the click. app-access-card-one-press.test.tsx holds the behaviour; this drives it with a real
 * mouse in the app's stylesheet, in the personal edition and as a team edition admin, and looks at
 * the app's page reached directly before the app is on.
 *
 *   OPENBOT_APP_BROWSER=1 bun test app/tests/one-press-connect-layout.test.tsx
 *
 * Chromium by default, as CI has it. OPENBOT_APP_ENGINES=chromium,webkit adds WebKit. With
 * OPENBOT_APP_SHOTS=<dir> each step is saved as one-press-<step>-<engine>-<theme>.png.
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
const FIREFLIES = "composio-fireflies";
const SLACK = "composio-slack";

/** The fixture bundled for the browser. `@/lib/marks` is Vite's `import.meta.glob`, so no marks. */
async function bundle(): Promise<string> {
  const built = await Bun.build({
    entrypoints: [
      join(import.meta.dir, "one-press-connect-layout.fixture.tsx"),
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
  // The transcript fades in once it is styled: wait for it, but not for a shimmer that never ends.
  await page.evaluate(() =>
    Promise.race([
      // A motion cancelled on the way (WebKit rejects its `finished`) is finished too.
      Promise.all(
        document
          .getAnimations()
          .map((motion) => motion.finished.catch(() => undefined)),
      ),
      new Promise((done) => setTimeout(done, 1_500)),
    ]),
  );
}

/** The fixture at `path`, in a window the width of a desktop app. */
async function open(
  engine: string,
  theme: "light" | "dark",
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
    const path = new URL(route.request().url()).pathname;
    if (path === "/one-press.js")
      return route.fulfill({ contentType: "text/javascript", body: script });
    const font = join(inter, path.split("/").pop() ?? "");
    if (path.startsWith("/files/") && existsSync(font))
      return route.fulfill({ path: font });
    // The fixture answers the API itself; anything that reaches the network has nowhere to go.
    if (path.startsWith("/api/")) return route.fulfill({ status: 404 });
    return route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html lang="en" class="${theme}" style="color-scheme: ${theme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head><body><div id="root"></div><script type="module" src="/one-press.js"></script></body></html>`,
    });
  });
  const join_ = path.includes("?") ? "&" : "?";
  await page.goto(`${ORIGIN}${path}${join_}theme=${theme}`);
  return page;
}

async function shoot(page: Page, step: string, name: string) {
  if (!shots) return;
  mkdirSync(shots, { recursive: true });
  await page.screenshot({ path: join(shots, `one-press-${step}-${name}.png`) });
}

/** The card, once it has read the app and drawn its button. */
async function card(page: Page) {
  const drawn = page.locator("[data-app-access]");
  await drawn.locator("button, a").first().waitFor({ timeout: 15_000 });
  await style(page);
  return drawn;
}

/** How the card's one control sits: inside the card, on one line, nothing running off the side. */
function fits(page: Page) {
  return page.locator("[data-app-access]").evaluate((element) => {
    const box = element.getBoundingClientRect();
    const control = element.querySelector("button, a") as HTMLElement;
    const inner = control.getBoundingClientRect();
    return {
      inside: inner.left >= box.left && inner.right <= box.right,
      oneLine: inner.height < 40,
      sideways: document.documentElement.scrollWidth > innerWidth,
    };
  });
}

/** Whatever the press left: another page, or the card drawn for a state the press moved it to. */
async function pressed(page: Page) {
  await page.waitForFunction(
    () =>
      location.pathname !== "/" ||
      document
        .querySelector("[data-app-access]")
        ?.getAttribute("data-state") !== "disabled",
    undefined,
    { timeout: 15_000 },
  );
  await style(page);
}

/** The app's page with its key form open, as the press should leave it. */
async function keyFormOpen(page: Page) {
  await page.waitForURL(`**/connections/${FIREFLIES}*`, { timeout: 15_000 });
  await page.getByLabel("API key").waitFor({ timeout: 15_000 });
  await style(page);
}

/** What the page did, in order: its writes, and each tab claimed, sent somewhere, or closed. */
const events = (page: Page) =>
  page.evaluate(() => (window as unknown as { __events: string[] }).__events);

/**
 * The events about the app itself and its tab, leaving out the conversation's own requests and the
 * app page's own reads once it is open (its check on arrival, `/confirm`).
 */
async function appEvents(page: Page, app: string) {
  return (await events(page)).filter(
    (event) =>
      (event.includes(app) && !event.endsWith("/confirm")) ||
      event.startsWith("tab "),
  );
}

describe.skipIf(!asked)("one Connect on the chat card", () => {
  for (const engine of engines)
    for (const theme of ["light", "dark"] as const) {
      const name = `${engine}-${theme}`;

      test(`personal: Connect turns Fireflies on and opens its key form, in ${engine}, ${theme}`, async () => {
        const page = await open(engine, theme, "/?edition=personal");
        try {
          const drawn = await card(page);
          await shoot(page, "card", name);
          const button = drawn.getByRole("button").first();
          const label = await button.getAttribute("aria-label");
          const words = await button.textContent();
          expect(await fits(page)).toEqual({
            inside: true,
            oneLine: true,
            sideways: false,
          });

          await button.click();
          await pressed(page);
          await shoot(page, "after-press", name);
          expect([label, words]).toEqual(["Connect Fireflies", "Connect"]);
          await keyFormOpen(page);
          await shoot(page, "key-form", name);
          // Turned on, the tab claimed in case it signed in closed unused, and the key form asked for.
          expect(await appEvents(page, FIREFLIES)).toEqual([
            "tab claimed",
            `POST ${botAppPath("assistant", FIREFLIES)}/approve`,
            "tab closed",
            `POST ${myConnectionPath(FIREFLIES, "connect")}`,
          ]);
        } finally {
          await page.close();
        }
      }, 90_000);

      test(`personal: Connect on an app known to take a key claims no tab, in ${engine}, ${theme}`, async () => {
        const page = await open(
          engine,
          theme,
          "/?edition=personal&scheme=known",
        );
        try {
          const drawn = await card(page);
          await drawn
            .getByRole("button", { name: "Connect Fireflies" })
            .click();
          await keyFormOpen(page);
          expect(await appEvents(page, FIREFLIES)).toEqual([
            `POST ${botAppPath("assistant", FIREFLIES)}/approve`,
            `POST ${myConnectionPath(FIREFLIES, "connect")}`,
          ]);
        } finally {
          await page.close();
        }
      }, 90_000);

      test(`personal: Connect turns Slack on and opens its sign-in in the tab the click claimed, in ${engine}, ${theme}`, async () => {
        const page = await open(engine, theme, "/?edition=personal&app=slack");
        try {
          const drawn = await card(page);
          await shoot(page, "slack-card", name);
          const button = drawn.getByRole("button").first();
          const label = await button.getAttribute("aria-label");
          const words = await button.textContent();

          await button.click();
          await pressed(page);
          await page
            .getByText("Finish in the tab that opened.")
            .waitFor({ timeout: 15_000 })
            .catch(() => {});
          await style(page);
          await shoot(page, "slack-after-press", name);
          expect([label, words]).toEqual(["Connect Slack", "Connect"]);
          // Claimed before anything was asked of the server: inside the click, where a browser allows it.
          const seen = await appEvents(page, SLACK);
          expect(seen.slice(0, 3)).toEqual([
            "tab claimed",
            `POST ${botAppPath("assistant", SLACK)}/approve`,
            `POST ${myConnectionPath(SLACK, "connect")}`,
          ]);
          // OpenBot's step before a directory app's sign-in, which then goes on to the sign-in.
          expect(seen).toHaveLength(4);
          expect(seen[3].startsWith(`tab to ${ORIGIN}/connecting#`)).toBe(true);
          expect(
            await page.getByText("Finish in the tab that opened.").isVisible(),
          ).toBe(true);
        } finally {
          await page.close();
        }
      }, 90_000);

      test(`team admin: Connect and give it goes on to the key form, in ${engine}, ${theme}`, async () => {
        const page = await open(engine, theme, "/?edition=team");
        try {
          const drawn = await card(page);
          await shoot(page, "admin-card", name);
          const button = drawn.getByRole("button", {
            name: "Connect Fireflies and give it to Personal Assistant",
          });
          expect(await button.textContent()).toBe(
            "Connect and give it to Personal Assistant",
          );
          await button.click();
          await pressed(page);
          await shoot(page, "admin-after-press", name);
          await keyFormOpen(page);
          await shoot(page, "admin-key-form", name);
        } finally {
          await page.close();
        }
      }, 90_000);

      /*
       * FOUND IN DOGFOODING: Reconnect on Fireflies, whose key didn't pass its check, blanked the
       * screen for seconds and then landed on a page where nothing reconnected it. One press now
       * keeps the card where it is, saying it is working, then opens the key form over the account
       * that stands; the new key is taken.
       */
      test(`Reconnect on a key that didn't pass opens the key form in one press, and the card stays until then, in ${engine}, ${theme}`, async () => {
        const page = await open(
          engine,
          theme,
          "/?edition=team&state=reconnect&held=1",
        );
        try {
          const drawn = await card(page);
          await shoot(page, "reconnect-card", name);
          const button = drawn.getByRole("button", {
            name: "Reconnect Fireflies",
          });
          expect(await button.textContent()).toBe("Reconnect");
          await button.click();
          // The app's page is still being read: the conversation stays, and the card says so.
          await drawn
            .getByRole("button", { name: "Connecting…" })
            .waitFor({ timeout: 15_000 });
          expect(new URL(page.url()).pathname).toBe("/");
          await style(page);
          await shoot(page, "reconnect-working", name);
          expect(await fits(page)).toEqual({
            inside: true,
            oneLine: true,
            sideways: false,
          });
          await page.evaluate(() =>
            (window as unknown as { __release: () => void }).__release(),
          );
          await keyFormOpen(page);
          await shoot(page, "reconnect-key-form", name);
          await page.getByLabel("API key").fill("ff-new-key");
          await page.getByLabel("API key").press("Enter");
          await page
            .getByText(/Connected with your key\. Last checked/)
            .waitFor({ timeout: 15_000 });
          await style(page);
          await shoot(page, "reconnect-done", name);
          expect(await page.getByRole("dialog").count()).toBe(0);
        } finally {
          await page.close();
        }
      }, 90_000);

      test(`the app's page offers Reconnect beside Re-check for a key that didn't pass, in ${engine}, ${theme}`, async () => {
        const page = await open(
          engine,
          theme,
          `/connections/${FIREFLIES}?edition=team&state=reconnect`,
        );
        try {
          const reconnect = page.getByRole("button", { name: "Reconnect" });
          await reconnect.waitFor({ timeout: 15_000 });
          await page.getByRole("button", { name: "Re-check" }).waitFor();
          await style(page);
          await shoot(page, "reconnect-page", name);
          await reconnect.click();
          await page.getByLabel("API key").waitFor({ timeout: 15_000 });
          await style(page);
          await shoot(page, "reconnect-page-form", name);
        } finally {
          await page.close();
        }
      }, 90_000);

      test(`the app's page before it is on, in ${engine}, ${theme}`, async () => {
        const page = await open(
          engine,
          theme,
          `/connections/${FIREFLIES}?edition=personal`,
        );
        try {
          await page.getByRole("heading").first().waitFor({ timeout: 15_000 });
          await style(page);
          await shoot(page, "page-not-on", name);
          // Nobody is asked to turn it on here: the page has no switch for an app that isn't added.
          expect(await page.getByRole("switch").count()).toBe(0);
        } finally {
          await page.close();
        }
      }, 90_000);
    }
});
