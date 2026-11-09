import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Browser, Page } from "playwright-core";
import { compile } from "tailwindcss";

/**
 * The New Bot sheet's first screen shows the four frameworks people look for first above its
 * footer, in an 800px-tall window, before anything is scrolled.
 *
 * 800px is the height OpenBot Desktop's window commonly has on a Mac. Below the form (name,
 * instructions, who can see it, its computer, three apps) the sheet lists custom agents, Claude
 * Agent SDK, LangChain, Google ADK and AWS Strands first. With the form's old spacing only the
 * first of them cleared the footer at that height, and AWS Strands sat 108px under it.
 *
 * Rendered in a real Chromium, because whether a row clears the footer is the browser's layout.
 * The sheet is the real component, bundled from the fixture beside this file, opened as the app
 * opens it; the stylesheet is the app's own `styles.css` built by Tailwind for exactly the classes
 * on the page. The server's answers are stubbed: a team deployment, three apps to give.
 *
 *   OPENBOT_APP_BROWSER=1 bun test app/tests/new-bot-sheet-fit.test.tsx
 */
const asked = process.env.OPENBOT_APP_BROWSER === "1";

const APP = join(import.meta.dir, "..");
const ORIGIN = "http://openbot.test";
/** The frameworks named first, in the order the sheet lists them. */
const NAMED = ["Claude Agent SDK", "LangChain", "Google ADK", "AWS Strands"];

/** The fixture bundled for the browser. `@/lib/marks` is Vite's `import.meta.glob`, so no marks. */
async function bundle(): Promise<string> {
  const built = await Bun.build({
    entrypoints: [join(import.meta.dir, "new-bot-sheet-fit.fixture.tsx")],
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

/** Where `@import "<package>[/<file>]"` lands, by the package's `style` export as Vite reads it. */
function packageStylesheet(id: string): string {
  const parts = id.split("/");
  const name = id.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
  const dir = [
    join(APP, "node_modules", name),
    join(APP, "..", "node_modules", name),
  ].find(existsSync);
  if (!dir) throw new Error(`no package for ${id}`);
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

/** The sheet open on its first screen, in a window this size, styled once it has drawn. */
async function open(width: number, height: number): Promise<Page> {
  const page = await browser.newPage({ viewport: { width, height } });
  await page.route(`${ORIGIN}/**`, (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/")
      return route.fulfill({
        contentType: "text/html",
        body: '<!doctype html><html lang="en"><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module" src="/sheet.js"></script></body></html>',
      });
    if (path === "/sheet.js")
      return route.fulfill({ contentType: "text/javascript", body: script });
    if (path === "/api/agents/capabilities")
      return route.fulfill({
        json: {
          capabilities: { builtInAvailable: true, isolationAvailable: true },
        },
      });
    if (path === "/api/admin/enterprise/me")
      return route.fulfill({
        json: { capabilities: { isolatedComputers: true }, enforced: true },
      });
    if (path === "/api/plugins/giveable")
      return route.fulfill({
        json: {
          apps: ["Gmail", "Slack", "Notion"].map((displayName) => ({
            key: displayName.toLowerCase(),
            displayName,
            logo: null,
            account: "me",
          })),
        },
      });
    return route.fulfill({ status: 404 });
  });
  await page.goto(`${ORIGIN}/`);
  // The apps arrive after the sheet opens; they are part of what has to fit.
  await page.getByText("Notion").waitFor();
  const classes = await page.evaluate(() => [
    ...new Set(
      [...document.querySelectorAll("[class]")].flatMap((element) => [
        ...element.classList,
      ]),
    ),
  ]);
  await page.addStyleTag({ content: await stylesheet(classes) });
  return page;
}

/** Each custom agent's name and bottom edge, the footer's top edge, and how far the body scrolled. */
function measure(page: Page) {
  return page.evaluate(() => {
    const footer = document.querySelector('[data-slot="sheet-footer"]');
    const body = footer?.previousElementSibling;
    const rows = [...document.querySelectorAll("#new-bot-custom button")].map(
      (row) => ({
        name: row.querySelector(".font-medium")?.textContent ?? "",
        bottom: row.getBoundingClientRect().bottom,
      }),
    );
    return {
      rows,
      footerTop: footer?.getBoundingClientRect().top ?? 0,
      scrolled: body?.scrollTop ?? -1,
    };
  });
}

describe.skipIf(!asked)("the New Bot sheet in an 800px window", () => {
  test("the four named frameworks show above the footer before anything is scrolled", async () => {
    const page = await open(1280, 800);
    try {
      const { rows, footerTop, scrolled } = await measure(page);
      expect(scrolled).toBe(0);
      expect(rows.slice(0, 4).map((row) => row.name)).toEqual(NAMED);
      for (const row of rows.slice(0, 4)) {
        expect({ name: row.name, clear: row.bottom <= footerTop }).toEqual({
          name: row.name,
          clear: true,
        });
      }
    } finally {
      await page.close();
    }
  });
});
