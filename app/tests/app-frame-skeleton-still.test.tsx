import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Browser, BrowserType, Page, Route } from "playwright-core";
import { compile } from "tailwindcss";

/**
 * The frame drawn while the sign-in checks run lines up with the real one.
 *
 * Somebody who was signed in last time sees the app's frame from the main script's arrival
 * (`AppFrameSkeleton`, drawn by `_authed` while its checks run), and the real frame (`_app`) takes
 * its place once they pass. If the two differ by a pixel, the strip, the panel or the page's panel
 * jumps at the moment the app arrives, which is the very flash the skeleton is there to hide.
 *
 * In a real browser, through the real gate and the real frame around a stub page, with the answer to
 * who is signed in held 300 ms, as a server takes. Every animation frame from the skeleton's first
 * is recorded: where the strip, the panel and the page's panel are. They must not move at all, from
 * the skeleton to the settled page, in light and dark, with the panel left open and left folded, at
 * a desktop's width and a phone's (where the sidebar is a sheet, so only the page's panel shows).
 *
 *   OPENBOT_APP_BROWSER=1 bun test app/tests/app-frame-skeleton-still.test.tsx
 *
 * Chromium by default; OPENBOT_APP_ENGINES=chromium,webkit adds WebKit, as CI runs it. With
 * OPENBOT_APP_SHOTS=<dir> the skeleton and the settled frame are saved as
 * app-frame-<engine>-<width>-<panel>-<theme>-<skeleton|settled>.png.
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

/** How long the server takes to say who is signed in: the checks the skeleton is drawn through. */
const PERSON_AFTER_MS = 300;

const APP = join(import.meta.dir, "..");
const ORIGIN = "http://openbot.test";
const ORGANIZATION = "/api/v2/organizations/default";
const THEMES = ["light", "dark"] as const;
type Theme = (typeof THEMES)[number];
const PANELS = ["open", "folded"] as const;
type Panel = (typeof PANELS)[number];
/** A desktop's window, where the strip and the panel sit beside the page, and a phone's. */
const WIDTHS = [1280, 390] as const;
type Width = (typeof WIDTHS)[number];

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
    entrypoints: [
      join(import.meta.dir, "app-frame-skeleton-still.fixture.tsx"),
    ],
    target: "browser",
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    // The chat loads a map library only when a Bot draws a map. Nothing here does.
    external: ["maplibre-gl"],
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

/**
 * The CSS classes a bundle can draw: every word between its quotes and spaces, so the sheet is there
 * from the first frame. The frame's classes hold brackets, parentheses and `=`
 * (`w-(--sidebar-width-icon)`, `group-data-[collapsible=icon]:hidden`), so those cannot split a word.
 * A class can also hold single quotes (`[&_svg:not([class*='size-'])]:size-4`), so the words are
 * read once more with only double quotes and backticks as edges; Tailwind ignores what isn't a class.
 */
function wordsOf(code: string): string[] {
  return [
    ...new Set([
      ...(code.match(/[^\s"'`\\]+/g) ?? []),
      ...(code.match(/[^\s"`\\]+/g) ?? []),
    ]),
  ];
}

const browsers = new Map<string, Browser>();
let script: string;
let css: string;

beforeAll(async () => {
  if (!asked) return;
  script = await bundle();
  css = await stylesheet(wordsOf(script));
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

/** Whether the server has said who is signed in, and listed the conversations. */
type Trail = { person: boolean; conversations: boolean };

/**
 * One OpenBot's server, as far as the gate and the frame ask it: who is signed in comes after a
 * pause, every gate lets them through, and the frame's own reads have nothing in them. Everything
 * else is the API's plain not found, which the frame's banners and lists read as nothing to show.
 */
async function answer(route: Route, trail: Trail) {
  const request = route.request();
  const path = new URL(request.url()).pathname;
  if (request.method() === "GET" && path === `${ORGANIZATION}/people/me`) {
    await new Promise((done) => setTimeout(done, PERSON_AFTER_MS));
    await route.fulfill({
      json: {
        person: {
          id: "bea",
          email: "bea@example.com",
          name: "Bea Lund",
          needsName: false,
          image: null,
          role: "member",
          onboarding: null,
        },
        openbotVersion: null,
      },
    });
    trail.person = true;
    return;
  }
  if (request.method() === "GET" && path === `${ORGANIZATION}/people/me/terms`)
    return route.fulfill({
      json: { current: null, accepted: null, acceptanceNeeded: false },
    });
  if (
    request.method() === "GET" &&
    path === `${ORGANIZATION}/shortened-tool-names`
  )
    return route.fulfill({ json: { tools: [] } });
  if (request.method() === "GET" && path === `${ORGANIZATION}/deployment`)
    return route.fulfill({ json: { edition: "team" } });
  if (request.method() === "GET" && path === `${ORGANIZATION}/conversations`) {
    await route.fulfill({ json: { conversations: [], nextCursor: null } });
    trail.conversations = true;
    return;
  }
  return route.fulfill({
    status: 404,
    json: { status: 404, detail: "Not found." },
    headers: { "content-type": "application/problem+json" },
  });
}

/** Where one box was drawn, or null when it was not in the document. */
type Box = { x: number; y: number; width: number; height: number } | null;

/** What one animation frame showed: whether it was the skeleton, and where the three boxes were. */
type Frame = { skeleton: boolean; strip: Box; panel: Box; inset: Box };

/**
 * The page's own recorder, installed before anything of the page runs: on every animation frame
 * from the first one in which a frame's page panel exists, where the strip, the panel and the page's
 * panel are. Only the skeleton marks its page panel busy, which is how its frames are told apart.
 */
function recordFrames() {
  const frames: Frame[] = [];
  (window as unknown as { __frames: Frame[] }).__frames = frames;
  const boxOf = (selector: string): Box => {
    const element = document.querySelector(selector);
    if (!element) return null;
    const { x, y, width, height } = element.getBoundingClientRect();
    // The real frame keeps a panel with no area where the section has none; it holds nothing.
    return width === 0 && height === 0 ? null : { x, y, width, height };
  };
  const tick = () => {
    const inset = boxOf('[data-slot="sidebar-inset"]');
    if (inset || frames.length > 0)
      frames.push({
        skeleton: document.querySelector('[aria-busy="true"]') !== null,
        strip: boxOf('[data-slot="strip"]'),
        panel: boxOf('[data-slot="section-panel"]'),
        inset,
      });
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

/** The page's recorded frames so far. */
function framesOf(page: Page): Promise<Frame[]> {
  return page.evaluate(
    () => (window as unknown as { __frames: Frame[] }).__frames,
  );
}

/** Until the real frame's boxes have not changed for a dozen frames, at most three hundred. */
async function still(page: Page) {
  await page.evaluate(async () => {
    const boxes = () =>
      JSON.stringify(
        ["strip", "section-panel", "sidebar-inset"].map((slot) =>
          document
            .querySelector(`[data-slot="${slot}"]`)
            ?.getBoundingClientRect(),
        ),
      );
    let last = boxes();
    let same = 0;
    for (let frame = 0; frame < 300 && same < 12; frame += 1) {
      await new Promise((done) => requestAnimationFrame(done));
      const now = boxes();
      same = now === last ? same + 1 : 0;
      last = now;
    }
  });
}

async function open(
  engine: string,
  theme: Theme,
  panel: Panel,
  width: Width,
  trail: Trail,
  path: string,
): Promise<Page> {
  const browser = browsers.get(engine);
  if (!browser) throw new Error(`no ${engine}`);
  const page = await browser.newPage({
    viewport: { width, height: 800 },
    colorScheme: theme,
    reducedMotion: "reduce",
  });
  page.on("pageerror", (error) => console.error(error));
  // Somebody signed in last time, who left the panel open or folded (lib/auth/was-signed-in.ts, lib/sidebar.ts).
  await page.addInitScript((folded) => {
    window.localStorage.setItem("openbot-was-signed-in", "1");
    window.localStorage.setItem(
      "openbot-sidebar",
      folded ? "collapsed" : "expanded",
    );
  }, panel === "folded");
  await page.addInitScript(recordFrames);
  const inter = join(packageDir("@fontsource-variable/inter"), "files");
  await page.route(`${ORIGIN}/**`, (route) => {
    const where = new URL(route.request().url()).pathname;
    if (where === "/screens.js")
      return route.fulfill({ contentType: "text/javascript", body: script });
    const font = join(inter, where.split("/").pop() ?? "");
    if (where.startsWith("/files/") && existsSync(font))
      return route.fulfill({ path: font });
    if (where.startsWith("/api/")) return answer(route, trail);
    return route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><style>${css}</style></head><body><div id="root"></div><script type="module" src="/screens.js"></script></body></html>`,
    });
  });
  await page.goto(`${ORIGIN}${path}`);
  return page;
}

/** Waits until the server has been asked for what the page needs, or says which ask never came. */
async function heardFrom(trail: Trail, path: string) {
  // Routines asks for no conversations: the frame's panel, which would, is not there.
  const needed: (keyof Trail)[] =
    path === "/" ? ["person", "conversations"] : ["person"];
  const deadline = Date.now() + 15_000;
  for (const key of needed) {
    while (!trail[key]) {
      if (Date.now() > deadline)
        throw new Error(`the page never asked for the ${key}`);
      await new Promise((done) => setTimeout(done, 25));
    }
  }
}

/** `/` has a panel (Conversations'); `/routines` is a section with none. */
const PATHS = ["/", "/routines"] as const;

describe.skipIf(!asked)("The frame drawn during the sign-in checks", () => {
  for (const engine of engines)
    for (const path of PATHS)
      for (const width of WIDTHS)
        for (const panel of PANELS)
          for (const theme of THEMES)
            test(`lines up with the real one at ${path}, in ${engine}, ${width}px, panel ${panel}, ${theme}`, async () => {
              const trail: Trail = { person: false, conversations: false };
              const page = await open(engine, theme, panel, width, trail, path);
              const name = `app-frame-${engine}-${path === "/" ? "home" : path.slice(1)}-${width}-${panel}-${theme}`;
              try {
                await page.locator('[aria-busy="true"]').waitFor();
                if (shots) {
                  mkdirSync(shots, { recursive: true });
                  await page.screenshot({
                    path: join(shots, `${name}-skeleton.png`),
                  });
                }
                await page.locator("[data-stub-page]").waitFor();
                await heardFrom(trail, path);
                await still(page);
                if (shots)
                  await page.screenshot({
                    path: join(shots, `${name}-settled.png`),
                  });
                const frames = await framesOf(page);
                // Both frames were drawn, the skeleton first, or there is nothing to compare.
                expect(frames[0]?.skeleton).toBe(true);
                expect(frames.at(-1)?.skeleton).toBe(false);
                const first = frames[0];
                if (!first?.inset) throw new Error("no frame was recorded");
                // On a phone the sidebar is a sheet nobody has opened, so only the page's panel shows.
                const seen = (frame: Frame) =>
                  width === 390
                    ? { inset: frame.inset }
                    : {
                        strip: frame.strip,
                        panel: frame.panel,
                        inset: frame.inset,
                      };
                for (const frame of frames)
                  expect(seen(frame)).toEqual(seen(first));
              } finally {
                await page.close();
              }
            }, 60_000);
});
