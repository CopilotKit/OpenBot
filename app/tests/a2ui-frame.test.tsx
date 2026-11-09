import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Browser, Page } from "playwright-core";
import { compile } from "tailwindcss";

/**
 * An interface a Bot draws inside a Card shows one frame in the conversation, not two.
 *
 * CopilotKit draws its own frame, a border and 12px of padding, around every interface in a chat.
 * The catalog's Card draws a border too, and a Bot puts most interfaces in one, so the trip budget
 * the starter task asks for showed a box inside a box with a gap between them. When the interface's
 * top component is a Card that draws a box, the frame gives up its border and padding and the Card
 * is the one frame, the way the app's other cards sit in a conversation. An interface without one
 * (a bare Column, or a Card drawn as a borderless section) keeps the frame, its only box.
 *
 * Rendered in a real Chromium, because whether two boxes are drawn is the cascade of CopilotKit's
 * stylesheet, the app's and the catalog's inline styles. The transcript is the real component, the
 * interfaces arrive as the runtime's activities and CopilotKit's renderer draws them; the
 * stylesheets are CopilotKit's and the app's own, in the order main.tsx imports them.
 *
 *   OPENBOT_APP_BROWSER=1 bun test app/tests/a2ui-frame.test.tsx
 *
 * With OPENBOT_APP_SHOTS=<dir> it also saves the trip budget and the bare interface at a chat's
 * width, light and dark, as budget-light.png and so on.
 */
const asked = process.env.OPENBOT_APP_BROWSER === "1";
const shots = process.env.OPENBOT_APP_SHOTS;

const APP = join(import.meta.dir, "..");
const ORIGIN = "http://openbot.test";

async function bundle(): Promise<string> {
  const built = await Bun.build({
    entrypoints: [join(import.meta.dir, "a2ui-frame.fixture.tsx")],
    target: "browser",
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    // The catalog's Map loads it on demand; OpenBot omits Map and does not ship it.
    external: ["maplibre-gl"],
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

let browser: Browser;
let script: string;

beforeAll(async () => {
  if (!asked) return;
  script = await bundle();
  const { chromium } = await import("playwright-core");
  // The CI job installs full Chromium without the headless shell.
  browser = await chromium.launch({ channel: "chromium" });
});

afterAll(async () => {
  await browser?.close();
});

/** The conversation at a chat's width, styled once its interfaces have drawn. */
async function open(
  query = "",
  theme: "light" | "dark" = "light",
): Promise<Page> {
  const page = await browser.newPage({
    viewport: { width: 680, height: 900 },
    deviceScaleFactor: 2,
  });
  page.on("pageerror", (error) => console.error(error));
  const inter = join(packageDir("@fontsource-variable/inter"), "files");
  await page.route(`${ORIGIN}/**`, (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/")
      return route.fulfill({
        contentType: "text/html",
        body: `<!doctype html><html lang="en" class="${theme}"><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module" src="/frame.js"></script></body></html>`,
      });
    if (path === "/frame.js")
      return route.fulfill({ contentType: "text/javascript", body: script });
    // Inter, which the app's stylesheet asks for at ./files/.
    const font = join(inter, path.split("/").pop() ?? "");
    if (path.startsWith("/files/") && existsSync(font))
      return route.fulfill({ path: font });
    return route.fulfill({ status: 404 });
  });
  await page.goto(`${ORIGIN}/${query}`);
  await page
    .locator("[data-generative-ui-chat-surface] .a2ui-surface [data-a2ui-std]")
    .first()
    .waitFor({ timeout: 8000 });
  const classes = await page.evaluate(() => [
    ...new Set(
      [...document.querySelectorAll("[class]")].flatMap((element) => [
        ...element.classList,
      ]),
    ),
  ]);
  // CopilotKit's stylesheet first, then the app's, as main.tsx imports them.
  await page.addStyleTag({
    content: readFileSync(
      packageStylesheet("@copilotkit/react-core/v2/styles.css"),
      "utf8",
    ),
  });
  await page.addStyleTag({ content: await stylesheet(classes) });
  await page.evaluate(() => document.fonts.ready);
  return page;
}

/**
 * For each interface: which of the boxes around the whole of it draw a border (CopilotKit's frame,
 * and the interface's own top component), how far the interface sits inside the frame, and the
 * frame's padding.
 */
function frames(page: Page) {
  return page.$$eval("[data-generative-ui-chat-surface]", (all) =>
    all.map((frame) => {
      const surface = frame.querySelector(":scope > .a2ui-surface");
      let top = [...(surface?.children ?? [])].find(
        (child) => child.tagName !== "STYLE",
      );
      // A component with an accessible name the catalog does not apply itself is wrapped in a
      // `display: contents` span.
      if (top?.matches("[data-a2ui-accessibility]"))
        top = top.firstElementChild ?? undefined;
      if (!top) throw new Error("an interface drew nothing");
      const boxed = (element: Element) => {
        const style = getComputedStyle(element);
        return (["Top", "Right", "Bottom", "Left"] as const).every(
          (side) =>
            Number.parseFloat(style[`border${side}Width`]) > 0 &&
            style[`border${side}Style`] !== "none",
        );
      };
      const outer = frame.getBoundingClientRect();
      const inner = top.getBoundingClientRect();
      return {
        surface: frame.getAttribute("data-generative-ui-chat-surface"),
        bordered: [
          ...(boxed(frame) ? ["frame"] : []),
          ...(boxed(top) ? ["interface"] : []),
        ],
        inset: Math.round(inner.left - outer.left),
        padding: getComputedStyle(frame).paddingTop,
      };
    }),
  );
}

describe.skipIf(!asked)("the frame around an interface a Bot draws", () => {
  test("a Card on top is the one frame; without one, the frame stays", async () => {
    const page = await open();
    try {
      expect(await frames(page)).toEqual([
        // The trip budget: the Card's border alone, edge to edge with where the frame was.
        {
          surface: "budget",
          bordered: ["interface"],
          inset: 0,
          padding: "0px",
        },
        {
          surface: "labelled",
          bordered: ["interface"],
          inset: 0,
          padding: "0px",
        },
        // Nothing else draws a box, so the frame keeps its border and padding.
        { surface: "plain", bordered: ["frame"], inset: 13, padding: "12px" },
        { surface: "section", bordered: ["frame"], inset: 13, padding: "12px" },
      ]);
      // The budget is the whole interface, drawn: the total adds the three amounts.
      await page.getByText("Total $430").waitFor({ timeout: 4000 });
    } finally {
      await page.close();
    }
  }, 60_000);

  test.skipIf(!shots)(
    "screenshots at a chat's width",
    async () => {
      if (!shots) return;
      mkdirSync(shots, { recursive: true });
      for (const theme of ["light", "dark"] as const) {
        for (const only of ["budget", "plain"]) {
          const page = await open(`?only=${only}`, theme);
          try {
            // Once the turns have faded in.
            await page.evaluate(() =>
              Promise.all(
                document
                  .getAnimations()
                  .map((animation) =>
                    animation.effect?.getComputedTiming().endTime === Infinity
                      ? animation.cancel()
                      : animation.finish(),
                  ),
              ),
            );
            const bottom = await page.$eval(
              "[data-generative-ui-chat-surface]",
              (frame) => frame.getBoundingClientRect().bottom,
            );
            await page.screenshot({
              path: join(shots, `${only}-${theme}.png`),
              clip: { x: 0, y: 0, width: 680, height: Math.ceil(bottom) + 32 },
            });
          } finally {
            await page.close();
          }
        }
      }
    },
    120_000,
  );
});
