import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Message } from "@ag-ui/core";
import type { Browser, Page } from "playwright-core";
import { compile } from "tailwindcss";

/**
 * A reply stays where it was written. When a person sends a message, the transcript lifts it to the
 * top of the view and the reply streams into the room below it. That room stays once the reply is
 * done: the reply does not jump when the turn ends, nor when the person touches the trackpad or
 * scrolls up and back to the end afterwards.
 *
 * Seen in OpenBot 1.0.2: a short reply finished with room under it, and a moment later the room
 * collapsed and the reply dropped to sit on the composer. Going to the end, which a downward wheel
 * at the end asks for, made the scroller hide the spacer that was the room, and the view standing
 * in it was pulled down by its height in one frame.
 *
 * Rendered in a real Chromium, because the jump is the browser shortening a scrolled page under the
 * view. The transcript is the real component, bundled from the fixture beside this file, with the
 * app's own stylesheet; the test hands it a turn the way a channel does while a Bot replies, and
 * scrolls with a real mouse wheel.
 *
 *   OPENBOT_APP_BROWSER=1 bun test app/tests/transcript-room.test.tsx
 */
const asked = process.env.OPENBOT_APP_BROWSER === "1";

const APP = join(import.meta.dir, "..");
const ORIGIN = "http://openbot.test";
/** The transcript column's padding under its last row: the least room above the composer. */
const COLUMN_END = 24;

const QUESTION: Message = { id: "u5", role: "user", content: "ok thanks" };
const SHORT = "You're welcome. Glad the numbers helped.";
const LONG = Array.from(
  { length: 24 },
  (_, index) =>
    `${index + 1}. **Step ${index + 1}.** Go through the forecast for this region line by line, and mark every deal that moved since the last review.`,
).join("\n");

function reply(text: string): Message {
  return { id: "a5", role: "assistant", content: text };
}

/** The fixture bundled for the browser. `@/lib/marks` is Vite's `import.meta.glob`, so no marks. */
async function bundle(): Promise<string> {
  const built = await Bun.build({
    entrypoints: [join(import.meta.dir, "transcript-room.fixture.tsx")],
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
/** Built once, from every class a turn draws, and served in the page so it lays out styled. */
let css = "";

beforeAll(async () => {
  if (!asked) return;
  script = await bundle();
  const { chromium } = await import("playwright-core");
  // The CI job installs full Chromium without the headless shell.
  browser = await chromium.launch({ channel: "chromium" });
  // A first pass through a whole turn, to know which classes the stylesheet needs.
  const page = await open();
  try {
    const classes = new Set(await classesOn(page));
    for (const [turn, busy] of [
      [[QUESTION], true],
      [[QUESTION, reply(LONG)], true],
      [[QUESTION, reply(LONG)], false],
    ] as const) {
      await say(page, [...turn], busy);
      for (const name of await classesOn(page)) classes.add(name);
    }
    css = await stylesheet([...classes]);
  } finally {
    await page.close();
  }
}, 60_000);

afterAll(async () => {
  await browser?.close();
});

/** The conversation open at the end of its history, styled from the first frame. */
async function open(theme: "light" | "dark" = "light"): Promise<Page> {
  const page = await browser.newPage({
    viewport: { width: 1000, height: 700 },
  });
  page.on("pageerror", (error) => console.error(error));
  await page.route(`${ORIGIN}/**`, (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/")
      return route.fulfill({
        contentType: "text/html",
        body: `<!doctype html><html lang="en"><head><meta charset="utf-8"><style>${css}</style></head><body><div id="root"></div><script type="module" src="/transcript.js"></script></body></html>`,
      });
    if (path === "/transcript.js")
      return route.fulfill({ contentType: "text/javascript", body: script });
    return route.fulfill({ status: 404 });
  });
  await page.goto(`${ORIGIN}/?theme=${theme}`);
  await page.getByText("Question number 4").waitFor({ timeout: 8000 });
  await still(page);
  return page;
}

function classesOn(page: Page): Promise<string[]> {
  return page.evaluate(() => [
    ...new Set(
      [...document.querySelectorAll("[class]")].flatMap((element) => [
        ...element.classList,
      ]),
    ),
  ]);
}

/** Hand the transcript the turn so far, as a channel does, and wait for it to draw. */
async function say(page: Page, turn: Message[], busy: boolean) {
  await page.evaluate(
    ([next, running]) =>
      (
        window as unknown as {
          __say: (turn: unknown[], busy: boolean) => void;
        }
      ).__say(next, running),
    [turn, busy] as const,
  );
  const last = turn.at(-1);
  if (last?.role === "assistant" && typeof last.content === "string") {
    // The reply is revealed at a reading pace; wait for its last line, as the markdown draws it.
    const tail = (last.content.split("\n").at(-1) ?? "")
      .replace(/^\d+\.\s*/, "")
      .replace(/\*/g, "");
    await page.waitForFunction(
      (text) =>
        (document.querySelector('[data-message-id="a5"]')?.textContent ?? "")
          .replace(/\s+/g, " ")
          .includes(text),
      tail,
      { timeout: 15_000 },
    );
  }
  await still(page);
}

/** Until the view has not moved for a dozen frames: a send glides, and the scroller settles. */
async function still(page: Page) {
  await page.evaluate(async () => {
    const viewport = document.querySelector(
      '[data-slot="message-scroller-viewport"]',
    );
    let last = Number.NaN;
    let same = 0;
    for (let frame = 0; frame < 300 && same < 12; frame += 1) {
      await new Promise((done) => requestAnimationFrame(done));
      const top = viewport?.scrollTop ?? 0;
      same = Math.abs(top - last) < 0.5 ? same + 1 : 0;
      last = top;
    }
  });
}

/** Where the reply is in the view, and how far its end stands above the view's bottom edge. */
function whereIsTheReply(page: Page) {
  return page.evaluate(() => {
    const viewport = document
      .querySelector('[data-slot="message-scroller-viewport"]')
      ?.getBoundingClientRect();
    const question = document
      .querySelector('[data-message-id="u5"]')
      ?.getBoundingClientRect();
    const answer = document
      .querySelector('[data-message-id="a5"]')
      ?.getBoundingClientRect();
    if (!viewport || !question || !answer) throw new Error("no reply drawn");
    return {
      questionTop: Math.round(question.top - viewport.top),
      top: Math.round(answer.top - viewport.top),
      aboveBottom: Math.round(viewport.bottom - answer.bottom),
    };
  });
}

type Where = Awaited<ReturnType<typeof whereIsTheReply>>;

/**
 * The reply has not moved. Within a pixel, because the scroller rounds its spacer up, so the end
 * can sit a fraction of a pixel below where it holds a turn and a wheel scrolls that last fraction.
 * The jump this guards against is the height of the room, hundreds of pixels.
 */
function expectStill(now: Where, before: Where) {
  const moved = Object.fromEntries(
    (Object.keys(before) as (keyof Where)[]).map((key) => [
      key,
      now[key] - before[key],
    ]),
  );
  // A failure reads as how far each edge moved, against the nothing it should have.
  expect(moved).toEqual(
    Object.fromEntries(
      Object.entries(moved).map(([key, by]) => [
        key,
        Math.abs(by) <= 1 ? by : 0,
      ]),
    ),
  );
}

/** A real wheel over the conversation, the way a trackpad nudge arrives. */
async function wheel(page: Page, deltaY: number) {
  await page.mouse.move(500, 300);
  await page.mouse.wheel(0, deltaY);
  await still(page);
}

describe.skipIf(!asked)("the room a reply is written into", () => {
  for (const theme of ["light", "dark"] as const) {
    test(`${theme}: a short reply stays put when the turn ends and when the wheel moves at the end`, async () => {
      const page = await open(theme);
      try {
        await say(page, [QUESTION], true);
        await say(page, [QUESTION, reply("You're")], true);
        await say(page, [QUESTION, reply(SHORT)], true);
        const writing = await whereIsTheReply(page);
        // The question was lifted to the top, and the reply has room under it.
        expect(writing.questionTop).toBeLessThan(120);
        expect(writing.aboveBottom).toBeGreaterThan(200);

        await say(page, [QUESTION, reply(SHORT)], false);
        const done = await whereIsTheReply(page);

        await wheel(page, 120);
        const nudged = await whereIsTheReply(page);

        expectStill(done, writing);
        expectStill(nudged, writing);
      } finally {
        await page.close();
      }
    }, 60_000);
  }

  test("scrolling up and back to the end comes back to the reply where it was", async () => {
    const page = await open();
    try {
      await say(page, [QUESTION], true);
      await say(page, [QUESTION, reply(SHORT)], true);
      await say(page, [QUESTION, reply(SHORT)], false);
      const done = await whereIsTheReply(page);

      await wheel(page, -300);
      expect((await whereIsTheReply(page)).top).toBeGreaterThan(done.top);
      await wheel(page, 3000);

      expectStill(await whereIsTheReply(page), done);
    } finally {
      await page.close();
    }
  }, 60_000);

  test("a reply longer than the view ends the column's padding above the composer, and stays", async () => {
    const page = await open();
    try {
      await say(page, [QUESTION], true);
      await say(
        page,
        [QUESTION, reply(LONG.split("\n").slice(0, 3).join("\n"))],
        true,
      );
      await say(page, [QUESTION, reply(LONG)], true);
      const writing = await whereIsTheReply(page);
      expect(writing.aboveBottom).toBe(COLUMN_END);

      await say(page, [QUESTION, reply(LONG)], false);
      const done = await whereIsTheReply(page);
      await wheel(page, 120);

      expectStill(done, writing);
      expectStill(await whereIsTheReply(page), writing);
    } finally {
      await page.close();
    }
  }, 60_000);
});
