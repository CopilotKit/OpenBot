import { afterAll, describe, expect } from "bun:test";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Browser, Page } from "playwright-core";
import { compile } from "tailwindcss";
import { still } from "./page-still";
import { test } from "./renderer-crash";

/**
 * Deleting your account, in a real browser, in light and dark, wide and on a phone: General's
 * Delete account section with the organizations that stand in the way, the dialog filled in, the
 * dialog asking to sign in again, and the page an account scheduled to be deleted shows. And such
 * a member as others see them: "Deactivated" beside their name in the organization's members and
 * in the box that picks somebody from it. And, once the account is gone, what they said in a
 * conversation others are in, headed "Deleted user". Drawn from delete-account.fixture.tsx, styled by the
 * app's stylesheet. Nothing scrolls sideways, the dialog's buttons are all on screen, and the
 * blockers' buttons and the label sit inside their rows.
 *
 *   OPENBOT_APP_BROWSER=1 bun test app/tests/delete-account-layout.test.tsx
 *
 * Chromium by default, as CI has it. OPENBOT_APP_ENGINES=chromium,webkit adds WebKit. With
 * OPENBOT_APP_SHOTS=<dir> each screen is saved as delete-account-<state>-<engine>-<theme>-<width>.png.
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
const THEMES = ["light", "dark"] as const;
const WINDOWS = [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
];
const STATES = [
  "blockers",
  "dialog",
  "reauthenticate",
  "pending",
  "members",
  "picker",
  "ghost",
] as const;

async function bundle(): Promise<string> {
  const built = await Bun.build({
    entrypoints: [join(import.meta.dir, "delete-account.fixture.tsx")],
    target: "browser",
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
if (asked) script = await bundle();
const browsers: Browser[] = [];

afterAll(async () => {
  await Promise.all(browsers.map((browser) => browser.close()));
});

/** Styles what is on the page now, the dialog included once it is open. */
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

async function open(
  name: "chromium" | "webkit",
  theme: (typeof THEMES)[number],
  window: { width: number; height: number },
  state: (typeof STATES)[number],
): Promise<Page> {
  const playwright = await import("playwright-core");
  const engine = playwright[name];
  const browser =
    name === "chromium"
      ? // The CI job installs full Chromium without the headless shell.
        await engine.launch({ channel: "chromium" })
      : await engine.launch();
  browsers.push(browser);
  const page = await browser.newPage({
    viewport: window,
    colorScheme: theme,
    reducedMotion: "reduce",
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
      body: `<!doctype html><html lang="en" class="${theme}" style="color-scheme: ${theme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head><body><div id="root"></div><script type="module" src="/app.js"></script></body></html>`,
    });
  });
  const fixtureState = state === "dialog" ? "clear" : state;
  await page.goto(`${ORIGIN}/?state=${fixtureState}`, {
    waitUntil: "domcontentloaded",
  });
  if (state === "pending") {
    await page.getByRole("button", { name: "Cancel deletion" }).waitFor();
    await style(page);
    return page;
  }
  if (state === "members") {
    await page.getByRole("button", { name: "Remove Priya Raman" }).waitFor();
    await style(page);
    return page;
  }
  if (state === "ghost") {
    await page.getByText("Deleted user", { exact: true }).waitFor();
    await style(page);
    return page;
  }
  if (state === "picker") {
    await page.getByRole("combobox", { name: "Name or email" }).fill("a");
    await page.getByRole("option", { name: /Priya Raman/ }).waitFor();
    await style(page);
    return page;
  }
  const remove = page.getByRole("button", { name: "Delete account" });
  await remove.waitFor().catch(async (error) => {
    // What the page drew instead, to say why.
    console.error(await page.evaluate(() => document.body.innerText));
    throw error;
  });
  await style(page);
  await remove.scrollIntoViewIfNeeded();
  if (state === "blockers") return page;
  await remove.click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Type your email address").fill("dana@acme.test");
  await dialog.getByLabel("Type delete my account").fill("delete my account");
  if (state === "reauthenticate") {
    await dialog.getByRole("button", { name: "Delete in 14 days" }).click();
    await dialog.getByRole("button", { name: "Sign in again" }).waitFor();
  }
  await style(page);
  return page;
}

/** Whether the element is wholly inside the window. */
async function onScreen(page: Page, name: string): Promise<boolean> {
  const box = await page.getByRole("button", { name }).boundingBox();
  const size = page.viewportSize();
  return (
    !!box &&
    !!size &&
    box.x >= 0 &&
    box.y >= 0 &&
    box.x + box.width <= size.width &&
    box.y + box.height <= size.height
  );
}

describe.skipIf(!asked)("deleting your account, on screen", () => {
  for (const engine of engines)
    for (const theme of THEMES)
      for (const window of WINDOWS)
        for (const state of STATES) {
          test(`${state}, in ${engine}, ${theme}, ${window.width}px`, async () => {
            const page = await open(engine, theme, window, state);
            if (shots) {
              mkdirSync(shots, { recursive: true });
              await page.screenshot({
                path: join(
                  shots,
                  `delete-account-${state}-${engine}-${theme}-${window.width}.png`,
                ),
              });
            }
            const sideways = await page.evaluate(
              () =>
                document.documentElement.scrollWidth > innerWidth ||
                document.body.scrollWidth > innerWidth,
            );
            expect(sideways).toBe(false);
            if (state === "blockers") {
              // Each blocker's button sits inside its own row.
              for (const name of ["Open its settings", "Leave organization"]) {
                const button = await page
                  .getByRole("button", { name })
                  .boundingBox();
                const row = await page
                  .getByRole("button", { name })
                  .locator("xpath=ancestor::*[@data-slot='item'][1]")
                  .boundingBox();
                expect(button && row).toBeTruthy();
                if (button && row) {
                  expect(button.x).toBeGreaterThanOrEqual(row.x);
                  expect(button.x + button.width).toBeLessThanOrEqual(
                    row.x + row.width,
                  );
                }
              }
            }
            if (state === "dialog" || state === "reauthenticate")
              for (const name of ["Cancel", "Delete now", "Delete in 14 days"])
                expect(await onScreen(page, name)).toBe(true);
            // The refusal and its way on are on screen, not below the dialog's scroll.
            if (state === "reauthenticate")
              expect(await onScreen(page, "Sign in again")).toBe(true);
            if (state === "pending")
              for (const name of ["Cancel deletion", "Sign out"])
                expect(await onScreen(page, name)).toBe(true);
            // A deleted person's line is headed Deleted user, and nothing else names them.
            if (state === "ghost") {
              const text = await page.evaluate(() => document.body.innerText);
              expect(text).toContain("Deleted user");
              expect(text).not.toContain("Someone who left");
              expect(text).not.toContain("deleted-user:");
            }
            // The label is beside Priya's name, inside her row, and beside nobody else's.
            if (state === "members" || state === "picker") {
              const label = page.getByText("Deactivated", { exact: true });
              expect(await label.count()).toBe(1);
              const row =
                state === "members"
                  ? page
                      .getByRole("button", { name: "Remove Priya Raman" })
                      .locator("xpath=ancestor::*[@data-slot='item'][1]")
                  : page.getByRole("option", { name: /Priya Raman/ });
              const [box, inside] = await Promise.all([
                label.boundingBox(),
                row.boundingBox(),
              ]);
              expect(box && inside).toBeTruthy();
              if (box && inside) {
                expect(box.x).toBeGreaterThanOrEqual(inside.x);
                expect(box.x + box.width).toBeLessThanOrEqual(
                  inside.x + inside.width,
                );
              }
            }
            await page.close();
          }, 60_000);
        }
});
