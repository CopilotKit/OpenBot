import { afterAll, beforeAll, describe, expect } from "bun:test";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Browser, BrowserType, Page } from "playwright-core";
import { compile } from "tailwindcss";
import { getGetBotResponseMock } from "@/lib/api/generated/bots/bots.msw";
import { personBody } from "./accounts-api";
import { botGrantsBody } from "./bot-grants-api";
import { test } from "./renderer-crash";

/**
 * A Bot's reply reads as the conversation stored it, however a person switches between
 * conversations while it is written, in a real browser.
 *
 * Seen on OpenBot Cloud: a person left a conversation while its Bot was writing a long answer and
 * came back to it. The answer drew as every other fragment of itself ("ight from GitHub. The
 * Impeccable** ... a margin rule and Caslonthly-report vis B · The Key C with br") under a tall
 * empty space, and stayed that way. The conversation's stored copy was whole.
 *
 * Why: coming back joins the conversation's thread again, and the gateway replays the turn so far
 * from what it has stored of it, then carries the rest live. It stores the pieces of a batch out of
 * order, so what it replays is some of the pieces written so far, and every later piece numbered
 * below the highest one it replayed is dropped as already sent. The join's end used to keep the
 * screen's copy unless the stored one carried on from it, and a reply in fragments is never the
 * start of the whole one.
 *
 * The real sidebar and the real conversation are drawn in the app's frame, bundled from the fixture
 * beside this file, with the app's stylesheet and the app's runtime client. The server's answers are
 * routes at the API's and the runtime's addresses; the thread's gateway is a Phoenix socket served
 * here, sending what the real one sends. The person switches with real clicks on the sidebar.
 *
 *   OPENBOT_APP_BROWSER=1 bun test app/tests/conversation-switch.test.tsx
 *
 * Chromium by default, as CI has it. OPENBOT_APP_ENGINES=chromium,webkit adds WebKit. With
 * OPENBOT_APP_SHOTS=<dir> each step is saved as conversation-switch-<step>-<engine>-<theme>-<width>.png.
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
/** The page's address: the test's own server, on this computer. */
const origin = () => `http://127.0.0.1:${gatewayPort}`;
const ORGANIZATION = "/api/v2/organizations/default";

const DESIGN_THREAD = "design-thread";
const NOTES_THREAD = "notes-thread";
const RUN = "design-run";
const QUESTION = "asked";
const ANSWER = "answer";

/** The Bot's answer as the thread stored it, three paragraphs. */
const PARAGRAPHS = [
  "I read the skill straight from GitHub and worked through its steps for the landing page, then wrote three directions you can compare side by side.",
  "The Ledger is blue-black ink on pale green ledger paper, with a margin rule and serif headlines. It has a monthly report visual and a ruled comparison table for pricing.",
  "The Key Cabinet is deep green with brass and stamped numerals. A staggered statement layout replaces the feature cards, and each section opens like a drawer.",
];
const WHOLE = PARAGRAPHS.join("\n\n");

/** The answer in the pieces the Bot streamed it in, about a dozen characters each, in order. */
const PIECES = (() => {
  const pieces: string[] = [];
  for (let at = 0; at < WHOLE.length; at += 13)
    pieces.push(WHOLE.slice(at, at + 13));
  return pieces;
})();
/** How many pieces the Bot writes while nobody has the conversation open. */
const WRITTEN_AWAY = 6;
/** The most it writes before the person leaves, so some of the answer is still to come. */
const BEFORE_LEAVING = PIECES.length - WRITTEN_AWAY - 8;
/**
 * The pieces the gateway had stored of the first `written` when the person came back: a batch's
 * pieces are stored out of order, so the ones stored first are scattered through it.
 */
const storedOnReturn = (written: number) =>
  Array.from({ length: written }, (_, index) => index).filter(
    (index) => index % 3 !== 1 || index === written - 1,
  );

type Frame = [string | null, string | null, string, string, unknown];

/** An AG-UI event of the turn, numbered as the gateway numbers the run's events. */
function event(seq: number, fields: Record<string, unknown>) {
  return {
    ...fields,
    threadId: DESIGN_THREAD,
    runId: RUN,
    run_id: RUN,
    metadata: { cpki_event_id: `event-${seq}`, cpki_event_seq: seq },
  };
}
/** The run's events: its start, the answer's start, each piece, the answer's end, the run's end. */
const STARTED = 0;
const OPENED = 1;
const pieceSeq = (index: number) => 2 + index;
const ENDED = pieceSeq(PIECES.length);
const FINISHED = ENDED + 1;
const piece = (index: number) =>
  event(pieceSeq(index), {
    type: "TEXT_MESSAGE_CONTENT",
    messageId: ANSWER,
    delta: PIECES[index],
  });

/**
 * What the thread's store answers: the question, and the answer as far as the Bot has written it,
 * whole once the turn is over.
 */
function storedMessages(threadId: string) {
  if (threadId !== DESIGN_THREAD)
    return [
      { id: "notes-asked", role: "user", content: "Notes from today?" },
      { id: "notes-answer", role: "assistant", content: "Here are the notes." },
    ];
  return [
    {
      id: QUESTION,
      role: "user",
      content: "Give me three directions for the landing page.",
    },
    {
      id: ANSWER,
      role: "assistant",
      content: gateway.finished
        ? WHOLE
        : PIECES.slice(0, gateway.written).join(""),
    },
  ];
}

/** The gateway, as one page's thread sees it: how far the Bot has got, and how many joins so far. */
type Gateway = {
  joins: number;
  /** The next piece the Bot writes. */
  written: number;
  /** Set when the turn is over. */
  finished: boolean;
  /** Wakes the writer: the person is back, so the rest of the answer streams. */
  resume: () => void;
};

const BOT = {
  ...getGetBotResponseMock().bot,
  id: "design-bot",
  name: "Design Bot",
  mine: true,
  canManage: true,
  systemOwned: false,
  visibility: "private" as const,
};
const NOTES_BOT = { ...BOT, id: "notes-bot", name: "Notes Bot" };

let gatewayPort = 0;
let server: ReturnType<typeof Bun.serve> | undefined;
/** The gateway state of the page under test, one page at a time. */
let gateway: Gateway;

const sleep = (milliseconds: number) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

/**
 * What the gateway sends a browser that has joined the design thread.
 *
 * First join, the conversation opened while the Bot writes: the turn so far, then each piece live.
 * The person leaves part way, which ends the join. Second join, back while the Bot still writes:
 * the turn so far from what the gateway has stored of it, which is some of the pieces in one block,
 * then the pieces written after that block's highest number, live, and the turn's end. Any later
 * join, the turn over: the whole turn, replayed.
 */
async function design(
  send: (name: string, payload: unknown) => void,
  open: () => boolean,
) {
  gateway.joins += 1;
  const join = gateway.joins;
  if (gateway.finished) {
    for (const one of [
      event(STARTED, { type: "RUN_STARTED" }),
      event(OPENED, {
        type: "TEXT_MESSAGE_START",
        messageId: ANSWER,
        role: "assistant",
      }),
      { ...piece(0), delta: WHOLE },
      event(ENDED, { type: "TEXT_MESSAGE_END", messageId: ANSWER }),
      event(FINISHED, { type: "RUN_FINISHED" }),
    ])
      send("ag_ui_event", one);
    send("replay_complete", { latestEventId: `event-${FINISHED}` });
    send("stream_idle", { latestEventId: `event-${FINISHED}` });
    return;
  }
  send("ag_ui_event", event(STARTED, { type: "RUN_STARTED" }));
  send(
    "ag_ui_event",
    event(OPENED, {
      type: "TEXT_MESSAGE_START",
      messageId: ANSWER,
      role: "assistant",
    }),
  );
  if (join === 1) {
    send("replay_complete", { latestEventId: `event-${OPENED}` });
    // The Bot writes on, live, until the person leaves, which closes this join's socket.
    while (gateway.written < BEFORE_LEAVING && open()) {
      send("ag_ui_event", piece(gateway.written));
      gateway.written += 1;
      await sleep(150);
    }
    // And on while nobody watches, to where it is when they come back.
    await new Promise<void>((resolve) => {
      gateway.resume = resolve;
    });
    gateway.written += WRITTEN_AWAY;
    return;
  }
  // Back while the Bot still writes: the block of what was stored so far, its highest number last.
  const stored = storedOnReturn(gateway.written);
  const highest = stored[stored.length - 1];
  send("ag_ui_event", {
    ...piece(highest),
    delta: stored.map((index) => PIECES[index]).join(""),
  });
  send("replay_complete", { latestEventId: `event-${pieceSeq(highest)}` });
  // The rest, live; a piece numbered at or below the block's highest is taken as already sent.
  for (let index = highest + 1; index < PIECES.length; index += 1) {
    if (!open()) return;
    send("ag_ui_event", piece(index));
    gateway.written = index + 1;
    await sleep(60);
  }
  send(
    "ag_ui_event",
    event(ENDED, { type: "TEXT_MESSAGE_END", messageId: ANSWER }),
  );
  send("ag_ui_event", event(FINISHED, { type: "RUN_FINISHED" }));
  gateway.finished = true;
  send("stream_idle", { latestEventId: `event-${FINISHED}` });
}

/** The quiet conversation: its one finished turn, replayed. */
function notes(send: (name: string, payload: unknown) => void) {
  const run = "notes-run";
  const notesEvent = (seq: number, fields: Record<string, unknown>) => ({
    ...fields,
    threadId: NOTES_THREAD,
    runId: run,
    run_id: run,
    metadata: { cpki_event_id: `notes-${seq}`, cpki_event_seq: seq },
  });
  for (const one of [
    notesEvent(0, { type: "RUN_STARTED" }),
    notesEvent(1, {
      type: "TEXT_MESSAGE_START",
      messageId: "notes-answer",
      role: "assistant",
    }),
    notesEvent(2, {
      type: "TEXT_MESSAGE_CONTENT",
      messageId: "notes-answer",
      delta: "Here are the notes.",
    }),
    notesEvent(3, { type: "TEXT_MESSAGE_END", messageId: "notes-answer" }),
    notesEvent(4, { type: "RUN_FINISHED" }),
  ])
    send("ag_ui_event", one);
  send("replay_complete", { latestEventId: "notes-4" });
  send("stream_idle", { latestEventId: "notes-4" });
}

/** What the server answers: a status and a body, or nothing for an address it does not have. */
function answer(path: string): { status?: number; json?: unknown } | undefined {
  if (path === "/api/copilotkit/info")
    return {
      json: {
        version: "fixture",
        agents: {
          "design-bot": { description: "Fixture", capabilities: {} },
          "notes-bot": { description: "Fixture", capabilities: {} },
        },
        mode: "intelligence",
        intelligence: { wsUrl: `ws://127.0.0.1:${gatewayPort}/client` },
        telemetryDisabled: true,
      },
    };
  // Joining a thread: credentials for the gateway's socket and the thread's topic.
  const connect = path.match(/\/agent\/([^/]+)\/connect$/);
  if (connect) {
    const threadId = connect[1] === "design-bot" ? DESIGN_THREAD : NOTES_THREAD;
    return {
      json: {
        threadId,
        runId: null,
        joinToken: "join-token",
        realtime: {
          clientUrl: `ws://127.0.0.1:${gatewayPort}/client`,
          topic: `thread:${threadId}`,
        },
      },
    };
  }
  // Whether a conversation still has a run going: the design one does until its turn is over.
  const joinToken = path.match(/\/conversations\/([^/]+)\/join-tokens$/);
  if (joinToken) {
    const design = joinToken[1] === "design-conversation";
    const threadId = design ? DESIGN_THREAD : NOTES_THREAD;
    return {
      status: 201,
      json: {
        joinToken: "join-token",
        expiresAt: new Date(Date.now() + 30_000).toISOString(),
        threadId,
        runId: design && !gateway.finished ? RUN : null,
        realtime: {
          clientUrl: `ws://127.0.0.1:${gatewayPort}/client`,
          topic: `thread:${threadId}`,
        },
      },
    };
  }
  const bot = path.match(/\/bots\/([^/]+)$/);
  if (bot) return { json: { bot: bot[1] === "notes-bot" ? NOTES_BOT : BOT } };
  if (path === `${ORGANIZATION}/bots`)
    return { json: { bots: [BOT, NOTES_BOT], nextCursor: null } };
  if (/\/bots\/[^/]+\/grants$/.test(path)) return { json: botGrantsBody() };
  if (/\/bots\/[^/]+\/components$/.test(path))
    return { json: { components: [], nextCursor: null } };
  if (/\/computers\/[^/]+\/control$/.test(path))
    return {
      json: {
        holder: "bot",
        since: "2026-11-23T20:00:00.000Z",
        requested: false,
      },
    };
  if (path === `${ORGANIZATION}/people/me/capabilities`)
    return { json: { capabilities: {}, enforced: false } };
  if (path === `${ORGANIZATION}/people/me`)
    return {
      json: {
        person: personBody({
          id: "dana",
          name: "Dana Reyes",
          email: "dana.reyes@northwind.example",
          role: "admin",
        }),
        openbotVersion: "v1.2.0",
      },
    };
  if (path === `${ORGANIZATION}/deployment`)
    return {
      json: {
        generativeUi: true,
        selfHostBanner: false,
        localEvaluation: false,
        edition: "team",
        authProviders: [],
        ssoConfigured: false,
        ssoRequired: false,
      },
    };
  if (/\/conversations\/[^/]+\/(activity|signal-busy)$/.test(path))
    return { status: 204 };
  if (/\/conversations\/[^/]+\/voice-sessions$/.test(path))
    return { json: { sessions: [], nextCursor: null } };
  const thread = path.match(/\/threads\/([^/]+)\/messages$/);
  if (thread)
    return {
      json: { messages: storedMessages(decodeURIComponent(thread[1])) },
    };
  return undefined;
}

/** The fixture bundled for the browser. `@/lib/marks` is Vite's `import.meta.glob`, so no marks. */
async function bundle(): Promise<string> {
  const built = await Bun.build({
    entrypoints: [join(import.meta.dir, "conversation-switch.fixture.tsx")],
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

/** The page, under the theme its address asks for. */
function html(theme: string): string {
  return `<!doctype html><html lang="en" class="${theme}" style="color-scheme: ${theme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head><body><div id="root"></div><script type="module" src="/conversation.js"></script></body></html>`;
}

/** An answer of the server's, as the browser receives it. */
function reply(url: URL): Response {
  const path = url.pathname;
  if (path === "/conversation.js")
    return new Response(script, {
      headers: { "content-type": "text/javascript" },
    });
  if (path.startsWith("/files/")) {
    const font = join(
      packageDir("@fontsource-variable/inter"),
      "files",
      path.split("/").pop() ?? "",
    );
    if (existsSync(font)) return new Response(Bun.file(font));
  }
  if (path.startsWith("/api/")) {
    const said = answer(path);
    if (!said) return Response.json({ detail: "Not found." }, { status: 404 });
    return said.json === undefined
      ? new Response(null, { status: said.status ?? 200 })
      : Response.json(said.json, { status: said.status ?? 200 });
  }
  return new Response(html(url.searchParams.get("theme") ?? "light"), {
    headers: { "content-type": "text/html" },
  });
}

beforeAll(async () => {
  if (!asked) return;
  /*
   * The server and the thread's gateway in one, on this computer: the page, the API's and the
   * runtime's answers, and Phoenix's JSON protocol on the gateway's socket. One address for all of
   * them, because a browser keeps a page from elsewhere from opening a socket to this computer.
   */
  server = Bun.serve<{ open: boolean }>({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, bun) {
      const url = new URL(request.url);
      if (request.headers.get("upgrade") === "websocket")
        return bun.upgrade(request, { data: { open: true } })
          ? undefined
          : new Response("upgrade failed", { status: 400 });
      return reply(url);
    },
    websocket: {
      close(socket) {
        socket.data.open = false;
      },
      message(socket, message) {
        const [joinRef, ref, topic, name] = JSON.parse(
          String(message),
        ) as Frame;
        socket.send(
          JSON.stringify([
            joinRef,
            ref,
            topic,
            "phx_reply",
            { status: "ok", response: {} },
          ]),
        );
        if (name !== "phx_join") return;
        const send = (event: string, payload: unknown) => {
          if (socket.data.open && socket.readyState === 1)
            socket.send(JSON.stringify([joinRef, null, topic, event, payload]));
        };
        if (topic === `thread:${DESIGN_THREAD}`)
          void design(send, () => socket.data.open);
        else if (topic === `thread:${NOTES_THREAD}`) notes(send);
      },
    },
  });
  gatewayPort = server.port ?? 0;
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
  server?.stop(true);
});

/** Styled for everything now on the page. */
async function style(page: Page) {
  const classes = await page.evaluate(() =>
    [...document.querySelectorAll("[class]")].flatMap((element) => [
      ...element.classList,
    ]),
  );
  await page.addStyleTag({ content: await stylesheet([...new Set(classes)]) });
}

/** The page opened on the design conversation. */
async function open(
  engine: string,
  theme: "light" | "dark",
  window: { width: number; height: number },
): Promise<Page> {
  const browser = browsers.get(engine);
  if (!browser) throw new Error(`no ${engine}`);
  const page = await browser.newPage({
    viewport: window,
    colorScheme: theme,
    reducedMotion: "reduce",
  });
  page.on("pageerror", (error) => console.error(error));
  await page.goto(`${origin()}/channel/design-conversation?theme=${theme}`);
  return page;
}

async function shoot(page: Page, step: string, name: string) {
  if (!shots) return;
  mkdirSync(shots, { recursive: true });
  await style(page);
  await page.screenshot({
    path: join(shots, `conversation-switch-${step}-${name}.png`),
  });
}

/**
 * The conversation's words as drawn: each paragraph of the answer, how many times it shows, and
 * whether anything else the Bot wrote shows beside them.
 */
async function drawn(page: Page) {
  const text = (await page.locator("main").last().innerText()).replace(
    /\s+/g,
    " ",
  );
  const flat = (words: string) => words.replace(/\s+/g, " ");
  return {
    paragraphs: PARAGRAPHS.map(
      (paragraph) => text.split(flat(paragraph)).length - 1,
    ),
    question: text.split("Give me three directions").length - 1,
  };
}

/** Until the answer reads whole, or the time is up: what it last read as. */
async function settled(page: Page, timeoutMs = 10_000) {
  const until = Date.now() + timeoutMs;
  let last = await drawn(page);
  while (Date.now() < until) {
    if (last.paragraphs.every((count) => count === 1)) return last;
    await sleep(200);
    last = await drawn(page);
  }
  return last;
}

/** Switch to a conversation with the sidebar, as a person does. */
async function switchTo(page: Page, summary: string) {
  await page
    .getByRole("link", { name: new RegExp(summary) })
    .first()
    .click();
}

const WHOLE_ONCE = {
  paragraphs: PARAGRAPHS.map(() => 1),
  question: 1,
};

describe.skipIf(!asked)("switching conversations while a Bot answers", () => {
  for (const engine of engines)
    for (const theme of ["light", "dark"] as const)
      for (const window of [
        { width: 1280, height: 800 },
        { width: 820, height: 1000 },
      ])
        test(`the answer reads as stored after leaving mid-answer, coming back, and opening it again, in ${engine}, ${theme}, ${window.width}px`, async () => {
          gateway = {
            joins: 0,
            written: 0,
            finished: false,
            resume: () => {},
          };
          const page = await open(engine, theme, window);
          const name = `${engine}-${theme}-${window.width}`;
          try {
            // The Bot is writing; the person reads the start of it.
            await page
              .getByText(PIECES.slice(0, 3).join("").trim(), { exact: false })
              .waitFor({ timeout: 15_000 });
            await shoot(page, "writing", name);

            // They switch to another conversation while it writes, and the Bot writes on.
            await switchTo(page, "Meeting notes");
            await page.getByText("Here are the notes.").waitFor();
            gateway.resume();

            // Back while it still writes: the rest streams in, and the answer reads as stored.
            await switchTo(page, "Three landing page directions");
            const until = Date.now() + 15_000;
            while (!gateway.finished && Date.now() < until) await sleep(100);
            expect(gateway.finished).toBe(true);
            const back = await settled(page);
            await shoot(page, "back", name);
            expect(back).toEqual(WHOLE_ONCE);

            // Away and back again with the turn over.
            await switchTo(page, "Meeting notes");
            await page.getByText("Here are the notes.").waitFor();
            await switchTo(page, "Three landing page directions");
            const backAgain = await settled(page);
            await shoot(page, "back-again", name);
            expect(backAgain).toEqual(WHOLE_ONCE);

            // And opened again from nothing, as a reload or a new window does.
            // The stored copy can be on screen before the page joins the thread again, so the
            // join is waited for, and the answer read again once the replay has landed on it.
            await page.reload();
            const joined = Date.now() + 15_000;
            while (gateway.joins < 4 && Date.now() < joined) await sleep(100);
            expect(gateway.joins).toBe(4);
            const reopened = await settled(page, 15_000);
            await shoot(page, "reopened", name);
            expect(reopened).toEqual(WHOLE_ONCE);
            expect(gateway.joins).toBe(4);
          } finally {
            await page.close();
          }
        }, 120_000);
});
