import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Browser, Page } from "playwright-core";
import { compile } from "tailwindcss";

/**
 * Where an organization's plan shows, drawn by a real Chromium with the app's stylesheet: the bar
 * over every page, the Plan row on the organization's settings, the chat when a run is refused for
 * want of a plan, and the dialog once the free trial is used up. Each in the states a person meets:
 * on the free trial with runs left, the trial used up for an admin and for a member, a failed
 * payment, on the plan, and an OpenBot that needs no plan.
 *
 *   OPENBOT_APP_BROWSER=1 bun test app/tests/plan-notices-layout.test.tsx
 *
 * With OPENBOT_APP_SHOTS=<dir> it also saves each scene and state as plan-<scene>-<state>.png, and
 * the trial's screens in light and dark, wide and on a phone, beside one of the app's own dialogs.
 */
const asked = process.env.OPENBOT_APP_BROWSER === "1";
const shots = process.env.OPENBOT_APP_SHOTS;

const APP = join(import.meta.dir, "..");
const ORIGIN = "http://openbot.test";
/** The content column at OpenBot Desktop's default window, and at its narrowest. */
const DEFAULT_WIDTH = 650;
const NARROWEST_WIDTH = 370;
/** A wide browser window, and a phone. */
const WINDOWS = [1440, 390] as const;
const THEMES = ["light", "dark"] as const;
const ADD_CARD =
  "/api/auth/hosted/checkout?organizationId=Jq3xT9mLw2Vb8RnC5sYd0fKe";

type State = {
  name: string;
  plan: string;
  admin: boolean;
  employee?: boolean;
  pays?: boolean;
};
const STATES: State[] = [
  { name: "free", plan: "free", admin: true },
  { name: "none-admin", plan: "none", admin: true },
  { name: "none-member", plan: "none", admin: false },
  { name: "past-due-admin", plan: "past_due", admin: true },
  { name: "active", plan: "active", admin: true },
  { name: "not-required", plan: "not_required", admin: true },
];
/** A CopilotKit employee past the free allowance: still free, never a card, never blocked. */
const EMPLOYEE: State = {
  name: "employee",
  plan: "free",
  admin: true,
  employee: true,
};
const EMPLOYEE_LINE =
  "Free because you're a CopilotKit employee. Thanks, Uncle Atai!";
const SENTRY_ALT =
  "Sentry, a white golden retriever, sitting on a rock above a mountain meadow";
const SCENES = ["shell", "settings", "chat"] as const;
type Scene = (typeof SCENES)[number] | "dialog" | "signin";

async function bundle(): Promise<string> {
  const built = await Bun.build({
    entrypoints: [join(import.meta.dir, "plan-notices-layout.fixture.tsx")],
    target: "browser",
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
  });
  if (!built.success) throw new AggregateError(built.logs, "bundle failed");
  const script = built.outputs.find((output) => output.kind === "entry-point");
  if (!script) throw new Error("bundle has no entry point");
  // The pictures it imports, served beside it under the names the bundle gave them.
  for (const output of built.outputs)
    if (output.kind === "asset")
      assets.set(
        output.path.split("/").pop() ?? "",
        Buffer.from(await output.arrayBuffer()),
      );
  return script.text();
}

const assets = new Map<string, Buffer>();

function packageDir(name: string): string {
  const dir = [
    join(APP, "node_modules", name),
    join(APP, "..", "node_modules", name),
  ].find(existsSync);
  if (!dir) throw new Error(`no package ${name}`);
  return dir;
}

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

let browser: Browser;
let script: string;
const styled = new Map<string, string>();
if (asked) {
  script = await bundle();
  const { chromium } = await import("playwright-core");
  browser = await chromium.launch({ channel: "chromium" });
}

afterAll(async () => {
  await browser?.close();
});

/** A scene in a state, styled with the classes it wears, once `ready` is on the page. */
async function open(
  scene: Scene,
  state: State,
  {
    width = DEFAULT_WIDTH,
    theme = "light",
    ready,
  }: {
    width?: number;
    theme?: (typeof THEMES)[number];
    ready?: string;
  } = {},
): Promise<Page> {
  const page = await browser.newPage({
    viewport: { width, height: width < 600 ? 844 : 900 },
    deviceScaleFactor: 2,
    colorScheme: theme,
    reducedMotion: "reduce",
  });
  page.on("pageerror", (error) => console.error(error));
  const inter = join(packageDir("@fontsource-variable/inter"), "files");
  await page.route(`${ORIGIN}/**`, (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/")
      return route.fulfill({
        contentType: "text/html",
        body: `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head><body><div id="root"></div><script type="module" src="/plan.js"></script></body></html>`,
      });
    if (path === "/plan.js")
      return route.fulfill({ contentType: "text/javascript", body: script });
    const asset = assets.get(path.split("/").pop() ?? "");
    if (asset)
      return route.fulfill({
        contentType: path.endsWith(".webp") ? "image/webp" : "image/png",
        body: asset,
      });
    const font = join(inter, path.split("/").pop() ?? "");
    if (path.startsWith("/files/") && existsSync(font))
      return route.fulfill({ path: font });
    return route.fulfill({ status: 404 });
  });
  await page.goto(
    `${ORIGIN}/?scene=${scene}&plan=${state.plan}&admin=${state.admin ? 1 : 0}&employee=${state.employee ? 1 : 0}&pays=${state.pays ? 1 : 0}&width=${width}&theme=${theme}`,
  );
  await page.waitForFunction(
    () => (document.getElementById("root")?.textContent?.length ?? 0) > 0,
  );
  if (ready) await page.locator(ready).first().waitFor();
  await restyle(page, `${scene}:${state.name}:${ready ?? ""}`);
  return page;
}

/** The app's stylesheet for every class on the page now, and the page's transitions waited out. */
async function restyle(page: Page, key: string) {
  let css = styled.get(key);
  if (!css) {
    const classes = await page.evaluate(() =>
      [...document.querySelectorAll("[class]")].flatMap((element) => [
        ...element.classList,
      ]),
    );
    css = await stylesheet([...new Set(classes)]);
    styled.set(key, css);
  }
  await page.addStyleTag({ content: css });
  await page.evaluate(() => document.fonts.ready);
  // Styled after it was drawn, so a button's colour transition runs from the browser's own link
  // blue: wait it out, or the picture catches it half way.
  // The transitions start on the next frame and last 150ms, so let a few frames pass first.
  await page.waitForTimeout(400);
  await page.waitForFunction(() =>
    document
      .getAnimations()
      .every((running) => !(running instanceof CSSTransition)),
  );
}

async function shot(page: Page, name: string) {
  if (!shots) return;
  mkdirSync(shots, { recursive: true });
  await page.screenshot({ path: join(shots, `plan-${name}.png`) });
}

/** Waits for Sentry's photo to have loaded and been drawn. */
async function sentryDrawn(page: Page) {
  await page.waitForFunction((alt) => {
    const img = document.querySelector(
      `img[alt="${alt}"]`,
    ) as HTMLImageElement | null;
    return img?.complete === true && img.naturalWidth > 0;
  }, SENTRY_ALT);
}

/** Whether anything on the page runs off its right edge. */
function sideways(page: Page): Promise<boolean> {
  return page.evaluate(
    () =>
      document.documentElement.scrollWidth > innerWidth ||
      [...document.querySelectorAll("[role=dialog], [role=progressbar]")].some(
        (element) => element.getBoundingClientRect().right > innerWidth,
      ),
  );
}

describe.skipIf(!asked)("an organization's plan, where people see it", () => {
  for (const scene of SCENES)
    for (const state of STATES)
      test(`${scene}, ${state.name}`, async () => {
        const page = await open(scene, state);
        try {
          await shot(page, `${scene}-${state.name}`);
          const bar = page.getByRole("complementary", { name: "Plan" });
          const blocked = state.plan === "none" || state.plan === "past_due";
          if (scene === "shell") {
            // Nothing over the page while Bots run: on the free trial, on the plan, or no plan needed.
            if (!blocked) {
              await expect(bar.count()).resolves.toBe(0);
              return;
            }
            const box = await bar.boundingBox();
            // One line, as tall as its button, at the default window.
            expect(box?.height ?? 0).toBeLessThanOrEqual(42);
            const link = bar.getByRole("link");
            if (state.admin)
              await expect(link.getAttribute("href")).resolves.toBe(ADD_CARD);
            else await expect(link.count()).resolves.toBe(0);
          }
          if (scene === "settings") {
            const row = page.getByText("Plan", { exact: true });
            await expect(row.count()).resolves.toBe(
              state.plan === "not_required" ? 0 : 1,
            );
            const progress = page.getByRole("progressbar");
            if (state.plan === "free") {
              await expect(
                progress.getAttribute("aria-valuenow"),
              ).resolves.toBe("42");
              await expect(progress.textContent()).resolves.toContain(
                "42% used",
              );
            } else await expect(progress.count()).resolves.toBe(0);
          }
          if (scene === "chat") {
            const stopped = page.getByTestId("transcript-stopped");
            const link = stopped.getByRole("link");
            if (blocked && state.admin)
              await expect(link.getAttribute("href")).resolves.toBe(ADD_CARD);
            else await expect(link.count()).resolves.toBe(0);
          }
        } finally {
          await page.close();
        }
      }, 60_000);

  test("the bar fits the narrowest window without running off it", async () => {
    const page = await open("shell", STATES[1], { width: NARROWEST_WIDTH });
    try {
      await shot(page, "shell-none-admin-narrow");
      const overflow = await page.evaluate(() => {
        const bar = document.querySelector('[aria-label="Plan"]');
        return bar ? bar.scrollWidth - bar.clientWidth : -1;
      });
      expect(overflow).toBe(0);
    } finally {
      await page.close();
    }
  }, 60_000);
});

describe.skipIf(!asked)(
  "the free trial, wide and on a phone, light and dark",
  () => {
    for (const theme of THEMES)
      for (const width of WINDOWS) {
        /*
         * Found on the end-to-end run: the trial, added to the line under the heading, took it to
         * three lines and split "usage-" from "based" at a line's end. The line under the heading
         * keeps its two lines, and the trial is a line of its own with the word whole.
         */
        test(`OpenBot Cloud's sign-in says the trial tidily, ${theme}, ${width}px`, async () => {
          const page = await open("signin", STATES[5], {
            width,
            theme,
            ready: "[data-testid=cloud-trial-line]",
          });
          try {
            await shot(page, `signin-${theme}-${width}`);
            const laid = await page.evaluate(() => {
              const lines = (element: Element | null) => {
                if (!element) return -1;
                const height = Number.parseFloat(
                  getComputedStyle(element).lineHeight,
                );
                return Math.round(
                  element.getBoundingClientRect().height / height,
                );
              };
              const lede = [...document.querySelectorAll("p")].find((p) =>
                p.textContent?.startsWith("We run OpenBot for you."),
              );
              const trial = document.querySelector(
                "[data-testid=cloud-trial-line]",
              );
              const word = [...(trial?.querySelectorAll("span") ?? [])].find(
                (span) => span.textContent === "usage-based",
              );
              return {
                lede: lines(lede ?? null),
                trial: lines(trial),
                wordWhole: word ? word.getClientRects().length === 1 : false,
                says: trial?.textContent,
              };
            });
            expect(laid).toEqual({
              lede: 2,
              trial: 1,
              wordWhole: true,
              says: "New accounts start on a free usage-based trial.",
            });
            expect(await sideways(page)).toBe(false);
          } finally {
            await page.close();
          }
        }, 60_000);

        test(`the Plan row's bar, ${theme}, ${width}px`, async () => {
          const page = await open("settings", STATES[0], {
            width,
            theme,
            ready: "[role=progressbar]",
          });
          try {
            await shot(page, `settings-free-${theme}-${width}`);
            const track = await page
              .locator("[data-slot=progress-track]")
              .boundingBox();
            // A bar to read, not a hairline squeezed beside the label.
            expect(track?.width ?? 0).toBeGreaterThan(width < 600 ? 200 : 400);
            expect(await sideways(page)).toBe(false);
          } finally {
            await page.close();
          }
        }, 60_000);

        for (const state of [STATES[1], STATES[2]])
          test(`the trial-used-up dialog, ${state.name}, ${theme}, ${width}px`, async () => {
            const page = await open("dialog", state, {
              width,
              theme,
              ready: "[role=dialog]",
            });
            try {
              await shot(page, `dialog-${state.name}-${theme}-${width}`);
              const dialog = page.getByRole("dialog");
              await expect(dialog.textContent()).resolves.toContain(
                "Your free trial was 500 Bot runs",
              );
              const link = dialog.getByRole("link", { name: "Add a card" });
              if (state.admin)
                await expect(link.getAttribute("href")).resolves.toBe(ADD_CARD);
              else await expect(link.count()).resolves.toBe(0);
              expect(await sideways(page)).toBe(false);
            } finally {
              await page.close();
            }
          }, 60_000);

        test(`a CopilotKit employee's trial-used-up dialog, ${theme}, ${width}px`, async () => {
          const page = await open("dialog", EMPLOYEE, {
            width,
            theme,
            ready: "[role=dialog]",
          });
          try {
            const dialog = page.getByRole("dialog");
            const said = (await dialog.textContent()) ?? "";
            expect(said).toContain("Your free trial was 500 Bot runs");
            expect(said).toContain(EMPLOYEE_LINE);
            expect(said).toContain("Sentry loves you too.");
            // Sentry's photo, drawn, as wide as the dialog's text and no wider.
            const photo = dialog.getByAltText(SENTRY_ALT);
            await sentryDrawn(page);
            await shot(page, `dialog-employee-${theme}-${width}`);
            const laid = await photo.evaluate((img) => {
              const box = img.getBoundingClientRect();
              const body = img.parentElement?.getBoundingClientRect();
              const line = img.previousElementSibling?.getBoundingClientRect();
              return {
                drawn: (img as HTMLImageElement).naturalWidth > 0,
                fits:
                  !!body &&
                  box.left >= body.left - 0.5 &&
                  box.right <= body.right + 0.5,
                full: !!line && Math.abs(box.width - line.width) < 1,
              };
            });
            expect(laid).toEqual({ drawn: true, fits: true, full: true });
            expect(said).not.toContain("Ask an admin");
            // Only a way to close, and nothing over the page.
            await expect(dialog.getByRole("link").count()).resolves.toBe(0);
            await expect(
              page.getByRole("complementary", { name: "Plan" }).count(),
            ).resolves.toBe(0);
            expect(await sideways(page)).toBe(false);
          } finally {
            await page.close();
          }
        }, 60_000);

        /*
         * On a short window the photo takes the dialog past the screen: the dialog stays on it and
         * its body scrolls, down to Sentry's line.
         */
        test(`a CopilotKit employee's dialog on a short window scrolls, ${theme}, ${width}px`, async () => {
          const page = await open("dialog", EMPLOYEE, {
            width,
            theme,
            ready: "[role=dialog]",
          });
          try {
            await page.setViewportSize({ width, height: 520 });
            await sentryDrawn(page);
            const before = await page.evaluate(() => {
              const dialog = document.querySelector("[role=dialog]");
              const body = document.querySelector("[data-slot=dialog-body]");
              const box = dialog?.getBoundingClientRect();
              return {
                onScreen: !!box && box.top >= 0 && box.bottom <= innerHeight,
                scrolls: !!body && body.scrollHeight > body.clientHeight,
              };
            });
            expect(before).toEqual({ onScreen: true, scrolls: true });
            await page
              .locator("[data-slot=dialog-body]")
              .evaluate((body) => body.scrollTo({ top: body.scrollHeight }));
            await expect(
              page.getByText("Sentry loves you too.").isVisible(),
            ).resolves.toBe(true);
            await shot(page, `dialog-employee-short-${theme}-${width}`);
            expect(await sideways(page)).toBe(false);
          } finally {
            await page.close();
          }
        }, 60_000);

        test(`a CopilotKit employee admin's Plan row with Add a card for the others, ${theme}, ${width}px`, async () => {
          const page = await open(
            "settings",
            { ...EMPLOYEE, name: "employee-pays", pays: true },
            { width, theme, ready: "[role=progressbar]" },
          );
          try {
            await shot(page, `settings-employee-pays-${theme}-${width}`);
            await expect(
              page
                .getByRole("link", { name: "Add a card" })
                .getAttribute("href"),
            ).resolves.toBe(ADD_CARD);
            await expect(
              page
                .getByText(
                  "Everyone else in this organization needs a card added to keep their Bots running.",
                  { exact: false },
                )
                .count(),
            ).resolves.toBe(1);
            // Found on the first run: at 390px the line was cut off after two lines. It's whole.
            const cut = await page
              .getByText("Everyone else in this organization", { exact: false })
              .evaluate((line) => line.scrollHeight > line.clientHeight + 1);
            expect(cut).toBe(false);
            // The bar keeps its width with the button under it.
            const track = await page
              .locator("[data-slot=progress-track]")
              .boundingBox();
            expect(track?.width ?? 0).toBeGreaterThan(width < 600 ? 200 : 400);
            await expect(
              page.getByRole("complementary", { name: "Plan" }).count(),
            ).resolves.toBe(0);
            expect(await sideways(page)).toBe(false);
          } finally {
            await page.close();
          }
        }, 60_000);

        test(`a CopilotKit employee's Plan row, ${theme}, ${width}px`, async () => {
          const page = await open("settings", EMPLOYEE, {
            width,
            theme,
            ready: "[role=progressbar]",
          });
          try {
            await shot(page, `settings-employee-${theme}-${width}`);
            await expect(
              page.getByRole("progressbar").getAttribute("aria-valuenow"),
            ).resolves.toBe("100");
            await expect(page.getByText(EMPLOYEE_LINE).count()).resolves.toBe(
              1,
            );
            await expect(
              page.getByRole("link", { name: "Add a card" }).count(),
            ).resolves.toBe(0);
            expect(await sideways(page)).toBe(false);
          } finally {
            await page.close();
          }
        }, 60_000);

        // One of the app's own dialogs, from the same page, to hold the new one beside.
        test(`the app's Remove member dialog, for comparison, ${theme}, ${width}px`, async () => {
          const page = await open("settings", STATES[4], { width, theme });
          try {
            await page
              .getByRole("button", { name: "Remove Sam Okafor" })
              .click();
            await page.locator("[role=dialog]").waitFor();
            await restyle(page, `remove:${theme}:${width}`);
            await shot(page, `dialog-reference-remove-${theme}-${width}`);
          } finally {
            await page.close();
          }
        }, 60_000);
      }
  },
);
