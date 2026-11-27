import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Browser, BrowserType, Page, Route } from "playwright-core";
import { compile } from "tailwindcss";

/**
 * Home holds still while it loads.
 *
 * FOUND ON THE LIVE APP: the greeting changed from "Start a conversation" to "Hi <name>, what would
 * you like to work on?" once the conversation list came, the hint under the box appeared once the
 * Bots list came, and Explore Bots changed height with it. Home is centred in its column, so each of
 * these moved the heading and the box a person had already started reading and aiming at.
 *
 * In a real browser, through the app's own home route and its loader, with the edition and the
 * person read before the page draws (as the gate does) and the Bots list and conversation list
 * answered after 400 ms, as a server does: later than the loader waits for them. Every animation
 * frame from the first draws is recorded: where the heading and the box are, what the greeting says,
 * and whether the hint line is there. Reduced motion is asked for, so the page's rise on a first
 * visit does not count as movement. Run for the personal and the business edition, light and dark,
 * on a first visit and on a later one.
 *
 *   OPENBOT_APP_BROWSER=1 bun test app/tests/home-holds-still.test.tsx
 *
 * Chromium by default; OPENBOT_APP_ENGINES=chromium,webkit adds WebKit, as CI runs it. With
 * OPENBOT_APP_SHOTS=<dir> the settled screen is saved as home-holds-still-<engine>-<edition>-<theme>.png.
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

const EDITIONS = [
  { name: "personal", query: "personal" },
  { name: "business", query: "business" },
] as const;
const VISITS = ["first", "later"] as const;
type Visit = (typeof VISITS)[number];
/** How long the server takes to answer the two lists: longer than Home's loader waits (route-data.ts). */
const ANSWER_AFTER_MS = 400;
/** How long a test waits for the page to ask for both lists and have them answered. */
const ANSWERED_WITHIN_MS = 10_000;
/** The person the fixture signs in, and what Home says to them before their first conversation. */
const FIRST_CONVERSATION_GREETING =
  "Hi Sam Rivera, what would you like to work on?";

const APP = join(import.meta.dir, "..");
const ORIGIN = "http://openbot.test";
const ORGANIZATION = "/api/v2/organizations/default";
const BOTS = `${ORGANIZATION}/bots`;
const CONVERSATIONS = `${ORGANIZATION}/conversations`;
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

async function bundle(): Promise<string> {
  const built = await Bun.build({
    entrypoints: [join(import.meta.dir, "home-holds-still.fixture.tsx")],
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

/** The Bots list and conversation list, once answered. */
type Trail = {
  bots: boolean;
  conversations: boolean;
  /** The Bots the list answers with; the one Bot by default. */
  list?: (typeof bot)[];
  /** Whether the conversation list fails instead of answering with none. */
  conversationsFail?: boolean;
};

/** What one frame of the page showed. */
type Frame = {
  heading: number;
  box: number;
  boxHeight: number;
  greeting: string;
  hint: { visibility: string; text: string } | null;
  /** The box's and the hint's opacity with their ancestors', as a person sees them. */
  boxOpacity: number;
  hintOpacity: number;
};

const bot = {
  assignedToMe: false,
  keyFromOpenBot: false,
  avatarSeed: "seed",
  builtIn: true,
  canManage: true,
  endpoint: null,
  hasAuth: false,
  hasCallbackToken: false,
  isolated: false,
  isolationActive: false,
  isolationOffReason: null,
  hidden: false,
  pinned: false,
  mine: true,
  name: "Terra Bot",
  roleDescription: "Answers on OpenBot's model.",
  systemOwned: false,
  title: "Analyst",
  visibility: "public",
  id: "terra-bot",
  runsOnOpenBotModel: true,
};

/**
 * One OpenBot's server, as far as home asks it: the Bots list and the conversation list come after
 * a pause, and everything else home reads is the API's plain not found.
 */
async function answer(route: Route, trail: Trail) {
  const path = new URL(route.request().url()).pathname;
  if (route.request().method() === "GET" && path === BOTS) {
    await new Promise((done) => setTimeout(done, ANSWER_AFTER_MS));
    await route.fulfill({
      json: { bots: trail.list ?? [bot], nextCursor: null },
    });
    trail.bots = true;
    return;
  }
  if (route.request().method() === "GET" && path === CONVERSATIONS) {
    await new Promise((done) => setTimeout(done, ANSWER_AFTER_MS));
    await route.fulfill(
      trail.conversationsFail
        ? {
            status: 500,
            json: { status: 500, detail: "Something went wrong." },
            headers: { "content-type": "application/problem+json" },
          }
        : { json: { conversations: [], nextCursor: null } },
    );
    trail.conversations = true;
    return;
  }
  await route.fulfill({
    status: 404,
    json: { status: 404, detail: "Not found." },
    headers: { "content-type": "application/problem+json" },
  });
}

/**
 * The page's own recorder, installed before anything of the page runs: on every animation frame
 * from the first one in which the heading and the box exist, what they and the hint line look like.
 * Opacity is the product of an element's own and its ancestors', since the page fades them in
 * through the element that carries `data-intro`; a hidden hint counts as not seen at all.
 */
function recordFrames() {
  const frames: Frame[] = [];
  (window as unknown as { __homeFrames: Frame[] }).__homeFrames = frames;
  const effective = (element: Element) => {
    let opacity = 1;
    for (let at: Element | null = element; at; at = at.parentElement)
      opacity *= Number(getComputedStyle(at).opacity);
    return opacity;
  };
  const tick = () => {
    const heading = document.querySelector('[data-intro="heading"]');
    const box = document.querySelector('[data-intro="box"]');
    if (heading && box) {
      const hint = [...document.querySelectorAll("p")].find((line) =>
        line.textContent?.startsWith("OpenBot picks"),
      );
      const hidden = !hint || getComputedStyle(hint).visibility === "hidden";
      frames.push({
        heading: heading.getBoundingClientRect().top,
        box: box.getBoundingClientRect().top,
        boxHeight: box.getBoundingClientRect().height,
        greeting: document.querySelector("h1")?.textContent ?? "",
        hint: hint
          ? {
              visibility: getComputedStyle(hint).visibility,
              text: hint.textContent ?? "",
            }
          : null,
        boxOpacity: effective(box),
        hintOpacity: hint && !hidden ? effective(hint) : 0,
      });
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

/** The page's recorded frames so far. */
function framesOf(page: Page): Promise<Frame[]> {
  return page.evaluate(
    () => (window as unknown as { __homeFrames: Frame[] }).__homeFrames,
  );
}

/** Until the heading and the box have not moved for a dozen frames, at most three hundred. */
async function still(page: Page) {
  await page.evaluate(async () => {
    const tops = () =>
      ["heading", "box"].map(
        (name) =>
          document
            .querySelector(`[data-intro="${name}"]`)
            ?.getBoundingClientRect().top ?? Number.NaN,
      );
    let last = tops();
    let same = 0;
    for (let frame = 0; frame < 300 && same < 12; frame += 1) {
      await new Promise((done) => requestAnimationFrame(done));
      const now = tops();
      same = now.every((top, index) => Math.abs(top - (last[index] ?? 0)) < 0.5)
        ? same + 1
        : 0;
      last = now;
    }
  });
}

/**
 * The CSS classes a bundle can draw: every word between its quotes and spaces, so the sheet is there
 * from the first frame. The box's classes hold brackets, parentheses and `=`
 * (`has-data-[icon=inline-end]:pr-1.5`, `text-(length:--text-sm)`), so those cannot split a word.
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

async function open(
  engine: string,
  theme: Theme,
  edition: string,
  visit: Visit,
  trail: Trail,
  look: {
    width?: number;
    height?: number;
    reducedMotion?: "reduce" | "no-preference";
  } = {},
): Promise<Page> {
  const browser = browsers.get(engine);
  if (!browser) throw new Error(`no ${engine}`);
  const page = await browser.newPage({
    viewport: { width: look.width ?? 1280, height: look.height ?? 800 },
    colorScheme: theme,
    reducedMotion: look.reducedMotion ?? "reduce",
  });
  page.on("pageerror", (error) => console.error(error));
  await page.addInitScript(recordFrames);
  // A later visit is a Home that has already played its intro in this tab (lib/home-field.ts).
  if (visit === "later")
    await page.addInitScript(() =>
      window.sessionStorage.setItem("openbot.home-intro-played", "1"),
    );
  const inter = join(packageDir("@fontsource-variable/inter"), "files");
  const css = await stylesheet(wordsOf(script));
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
  await page.goto(`${ORIGIN}/?edition=${edition}`);
  return page;
}

/** Until both lists have been answered, failing with the one that never was. */
async function answered(trail: Trail) {
  const deadline = Date.now() + ANSWERED_WITHIN_MS;
  while (!(trail.bots && trail.conversations)) {
    if (Date.now() > deadline)
      throw new Error(
        `Home never had ${[
          trail.bots ? null : "the Bots list",
          trail.conversations ? null : "the conversation list",
        ]
          .filter(Boolean)
          .join(" or ")} answered within ${ANSWERED_WITHIN_MS} ms`,
      );
    await new Promise((done) => setTimeout(done, 25));
  }
}

/** Open home and let it load: both lists answered, a heading said, and then nothing moving. */
async function loaded(
  engine: string,
  theme: Theme,
  edition: string,
  visit: Visit,
  trail: Trail = { bots: false, conversations: false },
  look: Parameters<typeof open>[5] = {},
): Promise<{ page: Page; frames: Frame[] }> {
  const page = await open(engine, theme, edition, visit, trail, look);
  await page.locator('[data-intro="box"]').waitFor();
  await answered(trail);
  await page.locator("h1:not(:empty)").waitFor({ timeout: ANSWERED_WITHIN_MS });
  await still(page);
  return { page, frames: await framesOf(page) };
}

/**
 * What the heading said on every frame it said anything, which must be one greeting from the first
 * of them to the last: the heading may wait for the conversation list, but never changes its words.
 */
function greetingsOf(frames: Frame[]): string[] {
  return [...new Set(frames.map((frame) => frame.greeting).filter(Boolean))];
}

describe.skipIf(!asked)("Home while it loads", () => {
  for (const engine of engines)
    for (const edition of EDITIONS)
      for (const theme of THEMES)
        for (const visit of VISITS) {
          const where = `in ${engine}, ${edition.name} edition, ${theme}, ${visit} visit`;
          test(`the heading and box don't move once drawn, ${where}`, async () => {
            const { page, frames } = await loaded(
              engine,
              theme,
              edition.query,
              visit,
            );
            try {
              if (shots) {
                mkdirSync(shots, { recursive: true });
                await page.screenshot({
                  path: join(
                    shots,
                    `home-holds-still-${engine}-${edition.name}-${theme}-${visit}.png`,
                  ),
                });
              }
              const first = frames[0];
              if (!first) throw new Error("no frame was recorded");
              for (const frame of frames) {
                expect(Math.abs(frame.heading - first.heading)).toBeLessThan(
                  0.5,
                );
                expect(Math.abs(frame.box - first.box)).toBeLessThan(0.5);
              }
            } finally {
              await page.close();
            }
          }, 60_000);

          test(`the hint takes its line from the first paint, ${where}`, async () => {
            const { page, frames } = await loaded(
              engine,
              theme,
              edition.query,
              visit,
            );
            try {
              const first = frames[0];
              const last = frames.at(-1);
              if (!first || !last) throw new Error("no frame was recorded");
              expect(first.hint?.visibility).toBe("hidden");
              expect(last.hint?.visibility).toBe("visible");
              expect(last.hint?.text).toContain("OpenBot picks the right Bot");
              expect(Math.abs(last.boxHeight - first.boxHeight)).toBeLessThan(
                0.5,
              );
            } finally {
              await page.close();
            }
          }, 60_000);

          // The person has no conversations yet, and the list says so later than the loader waits.
          test(`the first conversation's greeting is the first one drawn and stays, ${where}`, async () => {
            const { page, frames } = await loaded(
              engine,
              theme,
              edition.query,
              visit,
            );
            try {
              expect(frames.at(-1)?.greeting).toBe(FIRST_CONVERSATION_GREETING);
              expect(greetingsOf(frames)).toEqual([
                FIRST_CONVERSATION_GREETING,
              ]);
            } finally {
              await page.close();
            }
          }, 60_000);
        }

  for (const engine of engines) {
    test(`a conversation list that fails leaves the plain greeting, drawn once, in ${engine}`, async () => {
      const { page, frames } = await loaded(
        engine,
        "light",
        "business",
        "later",
        { bots: false, conversations: false, conversationsFail: true },
      );
      try {
        expect(greetingsOf(frames)).toEqual(["Start a conversation"]);
      } finally {
        await page.close();
      }
    }, 60_000);

    // On a phone the first conversation's greeting takes two lines where the plain one takes one,
    // so the line kept for it while the list is on its way must already be the taller of the two.
    for (const visit of VISITS)
      test(`a late greeting moves nothing on a phone, ${visit} visit, in ${engine}`, async () => {
        const { page, frames } = await loaded(
          engine,
          "light",
          "business",
          visit,
          { bots: false, conversations: false },
          { width: 390, height: 800 },
        );
        try {
          if (shots) {
            mkdirSync(shots, { recursive: true });
            await page.screenshot({
              path: join(shots, `home-phone-greeting-${engine}-${visit}.png`),
            });
          }
          const first = frames[0];
          if (!first) throw new Error("no frame was recorded");
          expect(greetingsOf(frames)).toEqual([FIRST_CONVERSATION_GREETING]);
          for (const frame of frames) {
            expect(Math.abs(frame.heading - first.heading)).toBeLessThan(0.5);
            expect(Math.abs(frame.box - first.box)).toBeLessThan(0.5);
          }
        } finally {
          await page.close();
        }
      }, 60_000);
  }

  for (const engine of engines) {
    // Nothing on Home scrolls but Home itself, so Explore Bots hanging under the box must be
    // reachable by scrolling it in a window too short for them, as on a phone.
    for (const [width, height] of [
      [1280, 700],
      [390, 700],
    ] as const)
      test(`the last Explore Bot can be scrolled to at ${width}x${height}, in ${engine}`, async () => {
        const shared = Array.from({ length: 6 }, (_, index) => ({
          ...bot,
          builtIn: false,
          mine: false,
          visibility: "public",
          id: `shared-${index}`,
          name: `Shared Bot ${index}`,
        }));
        const trail: Trail = {
          bots: false,
          conversations: false,
          list: [bot, ...shared],
        };
        const page = await open(engine, "light", "business", "later", trail, {
          width,
          height,
        });
        try {
          await page.locator('[data-intro="explore"] li').first().waitFor();
          await still(page);
          const frames = await framesOf(page);
          const first = frames[0];
          if (!first) throw new Error("no frame was recorded");
          await page.mouse.move(width / 2, height / 2);
          await page.mouse.wheel(0, 2000);
          // Until the scroll has come to rest: the last card stays where it is for three frames.
          await page.evaluate(async () => {
            const frame = () =>
              new Promise<void>((done) => requestAnimationFrame(() => done()));
            let last = Number.NaN;
            let same = 0;
            for (let frames = 0; same < 3; frames++) {
              if (frames > 600)
                throw new Error("the scroll never came to rest");
              await frame();
              const bottom = [
                ...document.querySelectorAll('[data-intro="explore"] li'),
              ]
                .at(-1)
                ?.getBoundingClientRect().bottom;
              same = bottom === last ? same + 1 : 0;
              last = bottom ?? Number.NaN;
            }
          });
          const reach = await page.evaluate(() => {
            const last = [
              ...document.querySelectorAll('[data-intro="explore"] li'),
            ].at(-1);
            if (!last) return null;
            const box = last.getBoundingClientRect();
            const hit = document.elementFromPoint(
              box.left + box.width / 2,
              box.top + box.height / 2,
            );
            return {
              bottom: box.bottom,
              inner: window.innerHeight,
              reached: hit ? last.contains(hit) : false,
            };
          });
          if (!reach) throw new Error("no Explore Bot was drawn");
          if (shots) {
            mkdirSync(shots, { recursive: true });
            await page.screenshot({
              path: join(
                shots,
                `home-scrolled-${engine}-${width}x${height}.png`,
              ),
            });
          }
          expect(reach.bottom).toBeLessThanOrEqual(reach.inner);
          expect(reach.reached).toBe(true);
        } finally {
          await page.close();
        }
      }, 60_000);

    // From the very first frame the page draws, as the rise starts when Home mounts, and until the
    // rise is over and nothing moves.
    test(`the hint is never more visible than the box on a first visit, in ${engine}`, async () => {
      const { page, frames } = await loaded(
        engine,
        "light",
        "business",
        "first",
        { bots: false, conversations: false },
        { reducedMotion: "no-preference" },
      );
      try {
        expect(frames.length).toBeGreaterThan(0);
        // The rise was seen: the box starts out faded.
        expect(frames[0]?.boxOpacity ?? 1).toBeLessThan(1);
        for (const frame of frames)
          expect(frame.hintOpacity).toBeLessThanOrEqual(
            frame.boxOpacity + 0.001,
          );
      } finally {
        await page.close();
      }
    }, 60_000);
  }
});
