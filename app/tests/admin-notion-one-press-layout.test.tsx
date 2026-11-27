import { afterAll, beforeAll, describe, expect } from "bun:test";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Browser, BrowserType, Locator, Page } from "playwright-core";
import { compile } from "tailwindcss";
import { botAppPath } from "./bot-grants-api";
import { myConnectionPath } from "./connections-api";
import { test } from "./renderer-crash";

/**
 * Notion on the chat card, for the admin of their own organization, in a real browser.
 *
 * On OpenBot Cloud an admin asked General Assistant to connect Notion. The card told them "This Bot
 * hasn't been given Notion. Only an admin can give it.", and Give it answered "Notion has no tools
 * to give yet": the app had listed nothing, and the press stopped before the admin's sign-in. Now
 * the card says what is missing, and its one press turns the app on, opens the admin's sign-in in a
 * tab claimed on the click, and gives the app to the Bot once they're in. Notion and Gmail, both from
 * the directory.
 * app-access-card-one-press.test.tsx holds the behaviour; this drives it with a real mouse in the
 * app's stylesheet and looks at each step.
 *
 *   OPENBOT_APP_BROWSER=1 bun test app/tests/admin-notion-one-press-layout.test.tsx
 *
 * Chromium by default, as CI has it. OPENBOT_APP_ENGINES=chromium,webkit adds WebKit. With
 * OPENBOT_APP_SHOTS=<dir> each step is saved as <app>-<step>-<engine>-<theme>.png.
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
      join(import.meta.dir, "admin-notion-one-press-layout.fixture.tsx"),
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
  await page.evaluate(() =>
    Promise.race([
      Promise.all(document.getAnimations().map((motion) => motion.finished)),
      new Promise((done) => setTimeout(done, 1_500)),
    ]),
  );
}

/** The fixture, with `query`, in a window the width of a desktop app. */
async function open(
  engine: string,
  theme: "light" | "dark",
  query: string,
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
    if (path === "/notion.js")
      return route.fulfill({ contentType: "text/javascript", body: script });
    const font = join(inter, path.split("/").pop() ?? "");
    if (path.startsWith("/files/") && existsSync(font))
      return route.fulfill({ path: font });
    // The fixture answers the API itself; anything that reaches the network has nowhere to go.
    if (path.startsWith("/api/")) return route.fulfill({ status: 404 });
    return route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html lang="en" class="${theme}" style="color-scheme: ${theme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head><body><div id="root"></div><script type="module" src="/notion.js"></script></body></html>`,
    });
  });
  await page.goto(`${ORIGIN}/?theme=${theme}${query}`);
  return page;
}

async function shoot(page: Page, step: string, name: string) {
  if (!shots) return;
  mkdirSync(shots, { recursive: true });
  await page.screenshot({ path: join(shots, `${step}-${name}.png`) });
}

/** The card, once it has read Notion and drawn its button. */
async function card(page: Page) {
  const drawn = page.locator("[data-app-access]");
  await drawn.getByRole("button").first().waitFor({ timeout: 15_000 });
  await style(page);
  return drawn;
}

/** How the card sits: every line inside it, nothing running off the side. */
function fits(page: Page) {
  return page.locator("[data-app-access]").evaluate((element) => {
    const box = element.getBoundingClientRect();
    const inside = [...element.querySelectorAll("p, button")].every((child) => {
      const inner = child.getBoundingClientRect();
      return inner.left >= box.left && inner.right <= box.right;
    });
    return {
      inside,
      sideways: document.documentElement.scrollWidth > innerWidth,
    };
  });
}

/** What the page did about the app and its tab, in order, leaving out the conversation's own requests. */
const events = async (page: Page, key: string) =>
  (
    await page.evaluate(
      () => (window as unknown as { __events: string[] }).__events,
    )
  ).filter((event) => event.includes(key) || event.startsWith("tab "));

/**
 * The words the admin read and didn't understand: told to ask an admin, "no tools to give", and sent
 * away to the app's page. The card shown to an admin never says any of them.
 */
async function neverSaysTheOldWords(drawn: Locator) {
  const said = await drawn.innerText();
  expect(said).not.toContain("Only an admin");
  expect(said).not.toContain("tools to give");
  expect(said).not.toContain("Open its page under Apps");
  // Connect, never Turn on: turning an app on is not a step a person thinks of.
  expect(said).not.toMatch(/\bturn(ing|ed)? on\b/i);
}

/** The two apps, both from the directory: Notion and Gmail. */
const APPS = [
  {
    query: "",
    key: "composio-notion",
    title: "Notion",
    signIn: "https://backend.composio.dev/api/v3/s/notion-consent",
  },
  {
    query: "&app=gmail",
    key: "composio-gmail",
    title: "Gmail",
    signIn: "https://backend.composio.dev/api/v3/s/gmail-consent",
  },
] as const;

describe.skipIf(!asked)("an app's card for an admin", () => {
  for (const app of APPS)
    for (const engine of engines)
      for (const theme of ["light", "dark"] as const) {
        const name = `${engine}-${theme}`;
        const step = (what: string) => `${app.title.toLowerCase()}-${what}`;

        test(`${app.title}: one press connects it, signs the admin in, and gives it to the Bot, in ${engine}, ${theme}`, async () => {
          const page = await open(engine, theme, app.query);
          try {
            const drawn = await card(page);
            await shoot(page, step("card"), name);
            expect(await drawn.innerText()).toContain(
              `${app.title} isn't connected yet.`,
            );
            await neverSaysTheOldWords(drawn);
            expect(await fits(page)).toEqual({ inside: true, sideways: false });

            await drawn
              .getByRole("button", {
                name: `Connect ${app.title} and give it to General Assistant`,
              })
              .click();
            await page
              .getByText("Finish in the tab that opened.")
              .waitFor({ timeout: 15_000 });
            await style(page);
            await shoot(page, step("signing-in"), name);
            expect(await fits(page)).toEqual({ inside: true, sideways: false });
            expect(await drawn.getByRole("alert").count()).toBe(0);
            await neverSaysTheOldWords(drawn);

            // The admin finishes the app's sign-in in the other tab.
            await page.evaluate(() =>
              (window as unknown as { __signIn: () => void }).__signIn(),
            );
            await page.waitForFunction(
              () =>
                document
                  .querySelector("[data-app-access]")
                  ?.getAttribute("data-state") === "ready",
              undefined,
              { timeout: 15_000 },
            );
            await style(page);
            await shoot(page, step("given"), name);
            expect(await drawn.getByRole("alert").count()).toBe(0);
            expect(await events(page, app.key)).toEqual([
              "tab claimed",
              `POST ${botAppPath("assistant", app.key)}/approve`,
              `POST ${myConnectionPath(app.key, "connect")}`,
              `tab to ${app.signIn}`,
              `POST ${botAppPath("assistant", app.key)}/approve`,
            ]);
          } finally {
            await page.close();
          }
        }, 90_000);

        test(`${app.title} already on: the card says it hasn't been given yet, and its press signs the admin in, in ${engine}, ${theme}`, async () => {
          const page = await open(engine, theme, `${app.query}&on=1`);
          try {
            const drawn = await card(page);
            await shoot(page, step("on-card"), name);
            expect(await drawn.innerText()).toContain(
              `This Bot hasn't been given ${app.title} yet.`,
            );
            await neverSaysTheOldWords(drawn);
            await drawn
              .getByRole("button", {
                name: `Give ${app.title} to General Assistant`,
              })
              .click();
            await page
              .getByText("Finish in the tab that opened.")
              .waitFor({ timeout: 15_000 });
            await style(page);
            await shoot(page, step("on-signing-in"), name);
            expect(await drawn.getByRole("alert").count()).toBe(0);
            await neverSaysTheOldWords(drawn);
          } finally {
            await page.close();
          }
        }, 90_000);

        /*
         * Where the press still can't go on (the admin signed in and the app answered nothing), the
         * card says so in plain words with the one thing to do, beside the button, inside the card.
         */
        test(`${app.title}: a press the server can't carry out says why in plain words, in ${engine}, ${theme}`, async () => {
          const page = await open(
            engine,
            theme,
            `${app.query}&on=1&server=refuses`,
          );
          try {
            const drawn = await card(page);
            await drawn
              .getByRole("button", {
                name: `Give ${app.title} to General Assistant`,
              })
              .click();
            await drawn.getByRole("alert").waitFor({ timeout: 15_000 });
            await style(page);
            await shoot(page, step("refused"), name);
            expect(await drawn.getByRole("alert").innerText()).toBe(
              `Couldn't get ${app.title} ready for this Bot. Try again in a moment.`,
            );
            await neverSaysTheOldWords(drawn);
            expect(await fits(page)).toEqual({ inside: true, sideways: false });
          } finally {
            await page.close();
          }
        }, 90_000);
      }
});
