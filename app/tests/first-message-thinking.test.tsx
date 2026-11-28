import { afterAll, beforeAll, describe, expect } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Browser, BrowserType, Page } from "playwright-core";
import { compile } from "tailwindcss";
import { getGetBotResponseMock } from "@/lib/api/generated/bots/bots.msw";
import { PREFERENCES_PATH, personBody } from "./accounts-api";
import { botGrantsBody } from "./bot-grants-api";
import {
  CONVERSATIONS_PATH,
  ORGANIZATION_PATH,
  ROUTE_PATH,
} from "./conversations-api";
import { still } from "./page-still";
import { test } from "./renderer-crash";

/**
 * A first message shows the Bot working from the moment Send is pressed until its first words.
 *
 * Reported from dogfooding: "after submitting new message, the primary window doesn't show any
 * indication of activity for a few seconds, which makes it look broken". A new conversation with
 * nobody in To: sends its message to the Bot OpenBot picks, and picking is a model call: for those
 * seconds the message sat alone under an empty box, with the "Thinking" line a conversation draws
 * under it nowhere. From home, the placeholder that shows the message and that line is a file of its
 * own, fetched on the first Send: until it came, home stood with its box emptied and nothing else.
 *
 * In a real browser, through the app's own routes (first-message-thinking.fixture.tsx): home and
 * its placeholder, a new conversation with nobody in To: and with a Bot in To:, and the
 * conversation each opens, with its real chat and a run streamed over the runtime's own wire. Each
 * step the server takes is slow on purpose (picking the Bot, making the conversation, starting the
 * run, the model's first words), and every frame from Send is read in the page: "Thinking" shows
 * within 200 ms and stays, frame by frame, until the Bot's first words are drawn.
 *
 * A starter task is a first message too, sent with a click instead of Send. From home it waited for
 * the conversation to be made before anything changed, with the task's row only greyed out: the
 * same few seconds of nothing. It is read the same way, from home and from a new conversation with
 * the Bot in To:, the two places the tasks are offered.
 *
 * A first message to two Bots in To: starts a group, and the new conversation showed nothing while
 * the group was made and the message sent; the group then opened on the message alone until its
 * next read found a Bot's run started. It is read the same way, through the group's own
 * conversation, to the first Bot's first words in its line.
 *
 *   OPENBOT_APP_BROWSER=1 OPENBOT_APP_ENGINES=chromium,webkit bun test app/tests/first-message-thinking.test.tsx
 *
 * Chromium by default; OPENBOT_APP_ENGINES=chromium,webkit adds WebKit, the engine OpenBot
 * Desktop's Mac window draws with, as CI runs it. With OPENBOT_APP_SHOTS=<dir> each step is saved as
 * first-message-thinking-<place>-<step>-<engine>-<width>-<theme>.png.
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
const QUESTION = "In one short sentence, what is a spring tide?";
const ANSWER =
  "Ahoy: a spring tide is the large tide that comes just after a new or full moon.";
/** The answer's first word, drawn first: the Bot's first words are on screen once it is. */
const FIRST_WORD = "Ahoy";
/** How soon after Send the line has to show. */
const SHOWN_WITHIN_MS = 200;
/**
 * The hand-over from the line to the words. The line goes in the frame the reply arrives, and the
 * reply is written in from the next (`paced-reveal.ts`), so a frame or two before the first word is
 * that, not a wait with nothing on screen. Counted in frames as well as time: with eight files
 * running at once in CI, a frame can take longer than 50 ms, and the hand-over frame with it.
 */
const REVEAL_HANDOFF_MS = 50;
const REVEAL_HANDOFF_FRAMES = 2;
/** The starter task clicked: its title, which is the task's button. */
const STARTER = "Chart Hacker News";

const BOT = {
  ...getGetBotResponseMock().bot,
  id: "tide-bot",
  name: "Tide Clerk",
  title: "Harbour master",
  mine: true,
  canManage: true,
  systemOwned: false,
  hidden: false,
  visibility: "public" as const,
  runsOnOpenBotModel: false,
  // One of the Bots OpenBot starts with, whose composer offers the starter tasks.
  packageBotId: "personal-assistant",
};

/** A second Bot, picked into To: beside the first to make a group. */
const OTHER_BOT = {
  ...BOT,
  id: "moon-bot",
  name: "Moon Reader",
  title: "Almanac keeper",
  packageBotId: null,
};

/** A line of a group conversation as the API lists it. */
type GroupLine = {
  id: string;
  role: "person" | "bot";
  personId: string | null;
  botId: string | null;
  text: string;
  status: string;
  createdAt: string;
};

/** How long each step the server takes is held, in milliseconds; null holds it until released. */
type Pace = {
  /** OpenBot picking the Bot for a message nobody was named for. */
  route: number | null;
  /** Making the conversation. */
  create: number | null;
  /** From the run's request to its RUN_STARTED. */
  runStarts: number | null;
  /** From RUN_STARTED to the model's first words. */
  firstWords: number | null;
};

const PACE: Pace = {
  route: 1200,
  create: 600,
  runStarts: 700,
  firstWords: 1200,
};

let pace: Pace = PACE;

/** How long the placeholder's own file takes to arrive: a slow connection's first fetch of it. */
const CHUNK_MS = 800;
/** How often the page asked for it, and how often it got it. */
const chunks = { asked: 0, sent: 0 };
/** Steps held until the test lets them go (a `null` in the pace), by name. */
const held = new Map<keyof Pace, () => void>();
let made = 0;
/** Whether making a conversation fails, for the start that cannot be made. */
let refuseCreate = false;
/** The conversations made, by id, with the thread each one's run answers on. */
const conversations = new Map<string, { threadId: string; ran: boolean }>();
/** The group conversations made, by id, with their lines, oldest first. */
const groups = new Map<string, GroupLine[]>();

function wait(step: keyof Pace): Promise<void> {
  const ms = pace[step];
  if (ms !== null) return new Promise((done) => setTimeout(done, ms));
  return new Promise((done) => held.set(step, done));
}

/** Let a held step go: the one waiting now, or the next to ask. */
function release(step: keyof Pace) {
  pace = { ...pace, [step]: 0 };
  held.get(step)?.();
  held.delete(step);
}

let port = 0;
let server: ReturnType<typeof Bun.serve> | undefined;

/** The run, streamed as the runtime streams it: started, then the Bot's words, then finished. */
function run(threadId: string, runId: string): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: Record<string, unknown>) =>
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(event)}\n\n`),
        );
      await wait("runStarts");
      send({ type: "RUN_STARTED", threadId, runId });
      await wait("firstWords");
      const messageId = `${runId}-answer`;
      send({ type: "TEXT_MESSAGE_START", messageId, role: "assistant" });
      send({ type: "TEXT_MESSAGE_CONTENT", messageId, delta: ANSWER });
      send({ type: "TEXT_MESSAGE_END", messageId });
      send({ type: "RUN_FINISHED", threadId, runId });
      controller.close();
    },
  });
  return new Response(stream, {
    headers: { "content-type": "text/event-stream" },
  });
}

/**
 * A group's turn on a person's message, as the server runs it with nobody's browser attached: the
 * first Bot's line is written as running when its run starts, and its words go into that line. Only
 * the first Bot is played: its first words are where the test stops reading.
 */
async function groupTurn(lines: GroupLine[], messageId: string) {
  await wait("runStarts");
  const line: GroupLine = {
    id: `${messageId}:${BOT.id}`,
    role: "bot",
    personId: "dana",
    botId: BOT.id,
    text: "",
    status: "running",
    createdAt: new Date().toISOString(),
  };
  lines.push(line);
  await wait("firstWords");
  line.text = ANSWER;
  line.status = "completed";
}

/** What the server answers for the API and the runtime. */
async function answer(request: Request, path: string): Promise<Response> {
  const json = (body: unknown, status = 200) => Response.json(body, { status });
  if (path === "/api/copilotkit/info")
    return json({
      version: "fixture",
      agents: { [BOT.id]: { description: "Fixture", capabilities: {} } },
      mode: "sse",
      telemetryDisabled: true,
    });
  if (/\/agent\/[^/]+\/run$/.test(path)) {
    const body = (await request.json()) as { threadId: string; runId: string };
    for (const conversation of conversations.values())
      if (conversation.threadId === body.threadId) conversation.ran = true;
    return run(body.threadId, body.runId);
  }
  if (path === ROUTE_PATH && request.method === "POST") {
    // Recorded for a Bot the person chose; a model call for a message nobody was named for.
    const body = (await request.json()) as { botId?: string };
    if (!body.botId) await wait("route");
    return json({
      botId: BOT.id,
      name: BOT.name,
      reason: "matched",
      fallback: false,
      viaMention: false,
    });
  }
  if (path === CONVERSATIONS_PATH && request.method === "POST") {
    const body = (await request.json()) as { group?: boolean };
    await wait("create");
    if (refuseCreate)
      return Response.json(
        { status: 503, detail: "Conversations can't be made right now." },
        {
          status: 503,
          headers: { "content-type": "application/problem+json" },
        },
      );
    made += 1;
    const id = `conversation-${made}`;
    conversations.set(id, { threadId: `thread-${made}`, ran: false });
    if (body.group) groups.set(id, []);
    return json({ conversation: conversationBody(id) }, 201);
  }
  const groupRead = path.match(/\/conversations\/([^/]+)\/(members|messages)$/);
  const lines = groupRead ? groups.get(groupRead[1]) : undefined;
  if (groupRead && lines) {
    if (groupRead[2] === "members")
      return json({
        members: [
          ...[BOT, OTHER_BOT].map((bot) => ({
            kind: "bot",
            id: bot.id,
            name: bot.name,
          })),
          {
            kind: "person",
            id: "dana",
            name: "Dana Reyes",
            email: "dana.reyes@northwind.example",
            creator: true,
          },
        ],
        nextCursor: null,
      });
    if (request.method === "POST") {
      // Taken, and answered by the server in its own time.
      const body = (await request.json()) as { id: string; text: string };
      lines.push({
        id: body.id,
        role: "person",
        personId: "dana",
        botId: null,
        text: body.text,
        status: "completed",
        createdAt: new Date().toISOString(),
      });
      void groupTurn(lines, body.id);
      return json({ id: body.id, queued: true }, 202);
    }
    // Newest first, as the API lists them.
    return json({
      messages: lines.map((line) => ({ ...line })).reverse(),
      nextCursor: null,
    });
  }
  const conversation = path.match(/\/conversations\/([^/]+)$/);
  if (conversation && conversations.has(conversation[1]))
    return json({ conversation: conversationBody(conversation[1]) });
  if (path === CONVERSATIONS_PATH)
    return json({
      conversations: [...conversations.keys()].map((id) => ({
        ...conversationBody(id),
        summary: null,
        lastMessage: null,
        lastMessageBotId: null,
        createdAt: "2026-11-27T10:00:00.000Z",
        pinned: false,
        lastReadAt: null,
      })),
      nextCursor: null,
    });
  if (/\/conversations\/[^/]+\/(activity|signal-busy)$/.test(path))
    return new Response(null, { status: 204 });
  if (/\/conversations\/[^/]+\/voice-sessions$/.test(path))
    return json({ sessions: [], nextCursor: null });
  const thread = path.match(/\/threads\/([^/]+)\/messages$/);
  if (thread) {
    const ran = [...conversations.values()].find(
      (one) => one.threadId === decodeURIComponent(thread[1]),
    )?.ran;
    return json({
      messages: ran
        ? [
            { id: `${thread[1]}-asked`, role: "user", content: QUESTION },
            { id: `${thread[1]}-answer`, role: "assistant", content: ANSWER },
          ]
        : [],
    });
  }
  if (path === `${ORGANIZATION_PATH}/bots`)
    return json({ bots: [BOT, OTHER_BOT], nextCursor: null });
  if (path === `${ORGANIZATION_PATH}/bots/${BOT.id}`) return json({ bot: BOT });
  if (path === `${ORGANIZATION_PATH}/bots/${OTHER_BOT.id}`)
    return json({ bot: OTHER_BOT });
  if (/\/bots\/[^/]+\/grants$/.test(path)) return json(botGrantsBody());
  if (/\/bots\/[^/]+\/components$/.test(path))
    return json({ components: [], nextCursor: null });
  // Nothing saved: the starter tasks have not been taken yet, so they are offered.
  if (path === PREFERENCES_PATH) return json({});
  if (path === `${ORGANIZATION_PATH}/people/me/capabilities`)
    return json({ capabilities: {}, enforced: false });
  if (path === `${ORGANIZATION_PATH}/people/me`)
    return json({
      person: personBody({
        id: "dana",
        name: "Dana Reyes",
        email: "dana.reyes@northwind.example",
        role: "admin",
      }),
      openbotVersion: "v1.2.1",
    });
  if (path === `${ORGANIZATION_PATH}/deployment`)
    return json({
      generativeUi: true,
      selfHostBanner: false,
      localEvaluation: false,
      edition: "team",
      authProviders: [],
      ssoConfigured: false,
      ssoRequired: false,
    });
  return Response.json(
    { status: 404, detail: "Not found." },
    { status: 404, headers: { "content-type": "application/problem+json" } },
  );
}

function conversationBody(id: string) {
  const group = groups.has(id);
  return {
    id,
    name: group ? `${BOT.name}, ${OTHER_BOT.name}` : BOT.name,
    botIds: group ? [BOT.id, OTHER_BOT.id] : [BOT.id],
    threadId: conversations.get(id)?.threadId ?? `thread-${id}`,
    active: true,
    lastMessageAt: null,
  };
}

/** The fixture bundled for the browser. `@/lib/marks` is Vite's `import.meta.glob`, so no marks. */
async function bundle(): Promise<string> {
  const built = await Bun.build({
    entrypoints: [join(import.meta.dir, "first-message-thinking.fixture.tsx")],
    target: "browser",
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    // The chat loads a map library only when a Bot draws a map. Nothing here does.
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
  const entry = built.outputs.find((output) => output.kind === "entry-point");
  if (!entry) throw new Error("bundle has no entry point");
  return entry.text();
}

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

/** Every `.tsx` under a directory of the app's source, as paths from `src`. */
function sources(dir: string): string[] {
  return readdirSync(join(APP, "src", dir), { withFileTypes: true }).flatMap(
    (entry) =>
      entry.isDirectory()
        ? sources(join(dir, entry.name))
        : entry.name.endsWith(".tsx")
          ? [join(dir, entry.name)]
          : [],
  );
}

/**
 * The app's stylesheet, built by Tailwind for every class the screens here can draw, read from
 * their source, as the app's build does. Built before the page opens, so the frames read while the
 * message goes are styled ones.
 */
async function stylesheet(): Promise<string> {
  const classes = [
    ...sources("components"),
    "routes/_authed/_app/index.tsx",
    "routes/_authed/_app/start.$startId.tsx",
    "routes/_authed/_app/channel/new.tsx",
    "routes/_authed/_app/channel/$channelId.tsx",
    "routes/_authed/_app/group/$channelId.tsx",
  ].flatMap((file) =>
    readFileSync(join(APP, "src", file), "utf8").split(/[\s"'`{}]+/),
  );
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
  return compiler.build([...new Set(classes)]);
}

const browsers = new Map<string, Browser>();
let script: string;
let css: string;

function html(theme: string): string {
  return `<!doctype html><html lang="en" class="${theme}" style="color-scheme: ${theme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><style>${css}</style></head><body><div id="root"></div><script type="module" src="/screens.js"></script></body></html>`;
}

async function reply(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  if (path === "/screens.js")
    return new Response(script, {
      headers: { "content-type": "text/javascript" },
    });
  if (path === "/chunks/start.js") {
    chunks.asked += 1;
    await new Promise((done) => setTimeout(done, CHUNK_MS));
    chunks.sent += 1;
    return new Response("export {};", {
      headers: { "content-type": "text/javascript" },
    });
  }
  if (path.startsWith("/files/")) {
    const font = join(
      packageDir("@fontsource-variable/inter"),
      "files",
      path.split("/").pop() ?? "",
    );
    if (existsSync(font)) return new Response(Bun.file(font));
  }
  if (path.startsWith("/api/")) return answer(request, path);
  return new Response(html(url.searchParams.get("theme") ?? "light"), {
    headers: { "content-type": "text/html" },
  });
}

beforeAll(async () => {
  if (!asked) return;
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 60,
    fetch: reply,
  });
  port = server.port ?? 0;
  [script, css] = await Promise.all([bundle(), stylesheet()]);
  const playwright = await import("playwright-core");
  for (const engine of engines) {
    const type: BrowserType = playwright[engine];
    // The CI job installs full Chromium without the headless shell.
    browsers.set(
      engine,
      await type.launch(engine === "chromium" ? { channel: "chromium" } : {}),
    );
  }
}, 180_000);

afterAll(async () => {
  for (const browser of browsers.values()) await browser.close();
  server?.stop(true);
});

type Theme = "light" | "dark";

async function open(
  engine: string,
  path: string,
  { theme = "light", width = 1440 }: { theme?: Theme; width?: number } = {},
): Promise<Page> {
  const browser = browsers.get(engine);
  if (!browser) throw new Error(`no ${engine}`);
  const page = await browser.newPage({
    viewport: { width, height: width < 768 ? 844 : 900 },
    colorScheme: theme,
  });
  page.on("pageerror", (error) => console.error(error));
  const [pathname, search = ""] = path.split("?");
  const query = new URLSearchParams(search);
  query.set("theme", theme);
  await page.goto(`http://127.0.0.1:${port}${pathname}?${query}`);
  await page.getByRole("textbox", { name: "Message" }).waitFor();
  return page;
}

/** One frame as the page drew it: when, and what it showed. */
type Frame = { at: number; path: string; thinking: boolean; words: boolean };

/** How a first message is sent: written and sent with Enter, or a starter task clicked. */
type By = "typing" | "starter";

/**
 * Start reading every frame. Each frame is read in `requestAnimationFrame`, just before it is
 * drawn: whether the "Thinking" line is on screen, and whether the Bot's words are. `sent` is when
 * the page took the Enter, or the click.
 */
async function watchFrames(page: Page, by: By) {
  await page.evaluate(
    ({ firstWord, by }) => {
      const watch = window as unknown as {
        frames: Frame[];
        sent: number | null;
        watching: boolean;
      };
      watch.frames = [];
      watch.sent = null;
      watch.watching = true;
      document.addEventListener(
        by === "typing" ? "keydown" : "click",
        (event) => {
          if (
            watch.sent === null &&
            (by === "starter" || (event as KeyboardEvent).key === "Enter")
          )
            watch.sent = performance.now();
        },
        { capture: true },
      );
      const frame = (at: number) => {
        if (!watch.watching) return;
        const thinking = [...document.querySelectorAll('[role="status"]')].some(
          (line) =>
            line.textContent?.trim() === "Thinking" &&
            line.getClientRects().length > 0,
        );
        // A conversation with one Bot writes its words into its log; a group, into the Bot's line.
        const words = [
          ...document.querySelectorAll('[role="log"], [data-speaker]'),
        ].some((log) => log.textContent?.includes(firstWord));
        watch.frames.push({ at, path: location.pathname, thinking, words });
        requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    },
    { firstWord: FIRST_WORD, by },
  );
}

/** Send a first message, written and sent with Enter or a starter task clicked, watching every frame. */
async function sendWatched(page: Page, by: By) {
  if (by === "starter") {
    const task = page.getByRole("button", { name: STARTER });
    await task.waitFor();
    await watchFrames(page, by);
    await task.click();
    return;
  }
  const box = page.getByRole("textbox", { name: "Message" });
  await box.click();
  await page.keyboard.type(QUESTION);
  await watchFrames(page, by);
  await page.keyboard.press("Enter");
}

/** The Bot's words, once drawn: in a conversation's log, or in a group's line for that Bot. */
function answerShown(page: Page) {
  return page
    .locator('[role="log"], [data-speaker]')
    .filter({ hasText: ANSWER });
}

/** Pick a second Bot into To: beside the first, which makes the conversation a group. */
async function addBot(page: Page, name: string) {
  await page.getByPlaceholder("Add another Bot for a group…").click();
  await page.keyboard.type(name);
  await page.getByRole("option", { name }).click();
  await page
    .locator('[data-slot="conversation-header"]')
    .getByText(name)
    .waitFor();
}

/** Send a first message as `sendWatched` does, without watching. */
async function send(page: Page, by: By) {
  if (by === "starter") {
    await page.getByRole("button", { name: STARTER }).click();
    return;
  }
  await page.getByRole("textbox", { name: "Message" }).fill(QUESTION);
  await page.keyboard.press("Enter");
}

/** Every frame read since Send, once the Bot's words are drawn; and when Send was. */
async function framesToWords(page: Page) {
  await answerShown(page).waitFor({ timeout: 30_000 });
  // Three frames more, so the line is seen to go once the words are there.
  const read = await page.evaluate(
    () =>
      (window as unknown as { frames: Frame[] }).frames.filter(
        (frame) => frame.words,
      ).length,
  );
  await page.waitForFunction(
    (before) =>
      (window as unknown as { frames: Frame[] }).frames.filter(
        (frame) => frame.words,
      ).length >=
      before + 3,
    read,
  );
  return page.evaluate(() => {
    const watch = window as unknown as {
      frames: Frame[];
      sent: number;
      watching: boolean;
    };
    watch.watching = false;
    return { frames: watch.frames, sent: watch.sent };
  });
}

/**
 * What the frames say: how long after Send "Thinking" first showed, the frames between then and
 * the Bot's first words that did not show it (with where the page was), and whether it went once
 * the words were there.
 */
function read({ frames, sent }: { frames: Frame[]; sent: number }) {
  const after = frames.filter((frame) => frame.at >= sent);
  const first = after.find((frame) => frame.thinking);
  const words = after.findIndex((frame) => frame.words);
  const before = words === -1 ? after : after.slice(0, words);
  const from = first ? before.indexOf(first) : before.length;
  const wordsAt = words === -1 ? Number.POSITIVE_INFINITY : after[words].at;
  const handOver = new Set(
    words === -1 ? [] : before.slice(-REVEAL_HANDOFF_FRAMES),
  );
  return {
    shownAfterMs: first ? Math.round(first.at - sent) : null,
    framesWithout: before
      .slice(Math.max(from, 0))
      .filter(
        (frame) =>
          !frame.thinking &&
          !handOver.has(frame) &&
          wordsAt - frame.at > REVEAL_HANDOFF_MS,
      )
      .map((frame) => `${Math.round(frame.at - sent)}ms ${frame.path}`),
    wordsDrawn: words !== -1,
    goneWithWords: words !== -1 && !after.at(-1)?.thinking,
  };
}

/**
 * Where a first message is sent from, and the path it is sent on. A second Bot picked into To:
 * (`adds`) makes it a group's first message, which opens the group's own conversation.
 */
const PLACES: readonly { place: string; path: string; adds?: string }[] = [
  { place: "home", path: "/" },
  { place: "new-conversation", path: "/channel/new" },
  {
    place: "new-conversation-with-a-bot",
    path: `/channel/new?agent=${BOT.id}`,
  },
  {
    place: "new-conversation-with-two-bots",
    path: `/channel/new?agent=${BOT.id}`,
    adds: OTHER_BOT.name,
  },
];

/**
 * Every way a first message goes: written, from each place; and a starter task, from each place
 * that offers them (a new conversation offers them for the one Bot in To:, so not with nobody
 * there, nor to a group).
 */
const SENDS = [
  ...PLACES.map((where) => ({ ...where, by: "typing" as const })),
  ...PLACES.filter(
    ({ place, adds }) => place !== "new-conversation" && !adds,
  ).map((where) => ({ ...where, by: "starter" as const })),
];

/** The conversation a first message opens: a group's, for one sent to two Bots. */
const OPENS = (adds: string | undefined) =>
  adds ? /\/group\/conversation-/ : /\/channel\/conversation-/;

/** What a send is called in a test's name and a screenshot's. */
const named = ({ place, by }: (typeof SENDS)[number]) =>
  by === "starter" ? `a starter task on ${place}` : place;

describe.skipIf(!asked)(
  "a first message, from Send to the Bot's first words",
  () => {
    for (const engine of engines)
      for (const sent of SENDS)
        test(`shows "Thinking" within ${SHOWN_WITHIN_MS} ms and until the first words, from ${named(sent)}, in ${engine}`, async () => {
          pace = PACE;
          const page = await open(engine, sent.path);
          try {
            await still(page);
            if (sent.adds) await addBot(page, sent.adds);
            // Whatever the page fetched while it was open has arrived, as it has by the time
            // somebody has written a message. What it did not ask for, Send has to fetch.
            while (chunks.sent < chunks.asked)
              await new Promise((done) => setTimeout(done, 50));
            await sendWatched(page, sent.by);
            const seen = read(await framesToWords(page));
            expect(new URL(page.url()).pathname).toMatch(OPENS(sent.adds));
            expect(seen.wordsDrawn).toBe(true);
            expect(seen.shownAfterMs).not.toBeNull();
            expect(
              seen.shownAfterMs ?? Number.POSITIVE_INFINITY,
            ).toBeLessThanOrEqual(SHOWN_WITHIN_MS);
            expect(seen.framesWithout).toEqual([]);
            expect(seen.goneWithWords).toBe(true);
          } finally {
            await page.close();
          }
        }, 60_000);

    /*
     * A starter task from home that cannot start goes back home, as a written message does, with
     * the reason under the box. The task was never in the box, so what the person had written there
     * is still there, and the tasks are offered again.
     */
    for (const engine of engines)
      test(`a starter task from home that cannot start comes back home with its reason, the box's own words kept, in ${engine}`, async () => {
        pace = { ...PACE, create: 300 };
        refuseCreate = true;
        const DRAFT = "A note to myself, not sent yet";
        const page = await open(engine, "/");
        try {
          await page.getByRole("textbox", { name: "Message" }).fill(DRAFT);
          await page.getByRole("button", { name: STARTER }).click();
          await page.waitForURL(/\/start\//, { waitUntil: "commit" });
          await page.waitForURL((url) => url.pathname === "/");
          await page
            .getByRole("alert")
            .filter({ hasText: "Conversations can't be made right now." })
            .waitFor();
          expect(
            await page.getByRole("textbox", { name: "Message" }).innerText(),
          ).toBe(DRAFT);
          await page.getByRole("button", { name: STARTER }).waitFor();
          await shoot(
            page,
            `first-message-thinking-a-starter-task-on-home-failed-${engine}`,
          );
        } finally {
          refuseCreate = false;
          await page.close();
        }
      }, 60_000);
  },
);

/** Save the page as it is now, styled and still. */
async function shoot(page: Page, name: string) {
  if (!shots) return;
  mkdirSync(shots, { recursive: true });
  await still(page);
  await page.screenshot({ path: join(shots, `${name}.png`) });
}

describe.skipIf(!asked || !shots)(
  "screenshots of a first message on its way",
  () => {
    for (const engine of engines)
      test(`each step, wide and on a phone, light and dark, in ${engine}`, async () => {
        for (const width of [1440, 390])
          for (const theme of ["light", "dark"] as const)
            for (const sent of SENDS) {
              pace = {
                route: null,
                create: null,
                runStarts: null,
                firstWords: null,
              };
              const page = await open(engine, sent.path, { theme, width });
              const name = (step: string) =>
                `first-message-thinking-${named(sent).replaceAll(" ", "-")}-${step}-${engine}-${width}-${theme}`;
              try {
                if (sent.adds) await addBot(page, sent.adds);
                await shoot(page, name("1-before"));
                await send(page, sent.by);
                // What shows 300 ms after Send, while OpenBot picks the Bot (or, with one named,
                // makes the conversation): a moment in time is the point, so the wait is fixed.
                await page.waitForTimeout(300);
                await shoot(page, name("2-sent"));
                release("route");
                release("create");
                await page.waitForURL(OPENS(sent.adds), {
                  waitUntil: "commit",
                });
                await page
                  .locator('[data-slot="conversation-header"]')
                  .filter({ hasText: BOT.name })
                  .waitFor();
                await shoot(page, name("3-conversation-waiting"));
                release("runStarts");
                // The run has started and the model has said nothing yet, which the page draws
                // nothing new for: given the time to arrive.
                await page.waitForTimeout(300);
                await shoot(page, name("4-run-started"));
                release("firstWords");
                await answerShown(page).waitFor({ timeout: 30_000 });
                await shoot(page, name("5-first-words"));
              } finally {
                for (const step of [
                  "route",
                  "create",
                  "runStarts",
                  "firstWords",
                ] as const)
                  release(step);
                await page.close();
              }
            }
      }, 300_000);
  },
);
