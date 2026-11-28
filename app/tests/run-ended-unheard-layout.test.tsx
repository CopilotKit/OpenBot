import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Server } from "bun";
import type { Browser, BrowserType, Page } from "playwright-core";
import { compile } from "tailwindcss";
import { getGetBotResponseMock } from "@/lib/api/generated/bots/bots.msw";
import { RUN_ENDED_UNHEARD } from "@/lib/copilot/quiet-run";
import { personBody } from "./accounts-api";
import { botGrantsBody } from "./bot-grants-api";
import { still } from "./page-still";

/**
 * A run whose end never reached this browser is shown as it ended on the server, in a real browser.
 *
 * Found on OpenBot Cloud, in a phone's web view, at the highest reasoning level: a long answer
 * finished, its last events never reached the phone, and the turn ended "The Bot stopped before it
 * finished" with Carry on, under the whole answer. The server keeps how each run ended
 * (getConversationRun), and the conversation asks it once the server says no run is going.
 *
 * The real conversation is drawn in the app's frame, bundled from the fixture beside this file, with
 * the app's stylesheet, against a real HTTP server on this machine that answers at the API's and the
 * runtime's addresses. The run streams its start and the first half of its reply, and then nothing,
 * while the server finishes it (or fails it) and keeps the whole reply in the thread. The person
 * types and sends with a real keyboard and a real click.
 *
 *   OPENBOT_APP_BROWSER=1 bun test app/tests/run-ended-unheard-layout.test.tsx
 *
 * Chromium by default, as CI has it. OPENBOT_APP_ENGINES=chromium,webkit adds WebKit. With
 * OPENBOT_APP_SHOTS=<dir> each is saved as run-ended-unheard-<ends>-<engine>-<theme>-<width>.png.
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
const ORGANIZATION = "/api/v2/organizations/default";
const BOT_ID = "general-assistant";
const CONVERSATION = "launch-conversation";
const THREAD = "launch-thread";
const BOT_PATH = `${ORGANIZATION}/bots/${BOT_ID}`;

const ASKED =
  "Think hard about the launch plan and give me your recommendation.";
const WHOLE =
  "Here is the plan in full. The market is ready for a smaller first release. Of the three options, a staged launch to existing customers carries the least risk, and it is the one I recommend.";
const HEAD = WHOLE.slice(0, Math.floor(WHOLE.length / 2));

const BOT = {
  ...getGetBotResponseMock().bot,
  id: BOT_ID,
  name: "General Assistant",
  mine: true,
  canManage: true,
  systemOwned: false,
  visibility: "private" as const,
};

/**
 * How the run goes on the server, and what the server keeps. `onStep` is a run that finishes by
 * handing this browser a command for the Bot's computer, as a run that needs the computer does.
 */
type Scene = {
  ends: "finished" | "fails" | "onStep" | "carried";
  stored: unknown[];
  endings: Map<string, { outcome: string; endedAt: string }>;
  /** The runs asked for so far, and the commands the browser took through the gate. */
  runs?: number;
  steps?: number;
};
let scene: Scene = { ends: "finished", stored: [], endings: new Map() };

/** What the Bot says before its command, and once the command has run. */
const ABOUT_TO =
  "I'll finish the report and put the derivations and numerical checks in the attached PDF.";
const FINISHED_REPORT =
  "The report is finished: the derivations and the numerical checks are in report.pdf.";
const COMMAND = "pdflatex -interaction=nonstopmode report.tex";
const PRINTED = "Output written on report.pdf (12 pages).";

/**
 * The runs of a turn that ends on a command this browser never heard: the first finishes on the
 * server with the command, and this browser hears only its start; the next asks for the command
 * again, and the one after answers.
 */
function stepRun(input: {
  threadId: string;
  runId: string;
  messages: unknown[];
}): Response {
  scene.runs = (scene.runs ?? 0) + 1;
  const started = {
    type: "RUN_STARTED",
    threadId: input.threadId,
    runId: input.runId,
  };
  const finished = {
    type: "RUN_FINISHED",
    threadId: input.threadId,
    runId: input.runId,
  };
  const messageId = `reply-${input.runId}`;
  const toolCallId = `command-${input.runId}`;
  const call = {
    id: toolCallId,
    type: "function",
    function: {
      name: "computer_run_command",
      arguments: JSON.stringify({ command: COMMAND }),
    },
  };
  const callEvents = [
    {
      type: "TOOL_CALL_START",
      toolCallId,
      toolCallName: "computer_run_command",
      parentMessageId: messageId,
    },
    {
      type: "TOOL_CALL_ARGS",
      toolCallId,
      delta: JSON.stringify({ command: COMMAND }),
    },
    { type: "TOOL_CALL_END", toolCallId },
  ];
  scene.stored = input.messages;
  if (scene.runs === 1) {
    scene.stored = [
      ...input.messages,
      {
        id: messageId,
        role: "assistant",
        content: ABOUT_TO,
        toolCalls: [call],
      },
    ];
    scene.endings.set(input.runId, {
      outcome: "succeeded",
      endedAt: new Date().toISOString(),
    });
    const heard = [
      started,
      { type: "TEXT_MESSAGE_START", messageId, role: "assistant" },
      {
        type: "TEXT_MESSAGE_CONTENT",
        messageId,
        delta: ABOUT_TO.slice(0, Math.floor(ABOUT_TO.length / 2)),
      },
    ];
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(frames(heard)));
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    );
  }
  if (scene.runs === 2) {
    scene.stored = [
      ...input.messages,
      { id: messageId, role: "assistant", content: "", toolCalls: [call] },
    ];
    return new Response(frames([started, ...callEvents, finished]), {
      headers: { "content-type": "text/event-stream" },
    });
  }
  scene.stored = [
    ...input.messages,
    { id: messageId, role: "assistant", content: FINISHED_REPORT },
  ];
  return new Response(
    frames([
      started,
      { type: "TEXT_MESSAGE_START", messageId, role: "assistant" },
      { type: "TEXT_MESSAGE_CONTENT", messageId, delta: FINISHED_REPORT },
      { type: "TEXT_MESSAGE_END", messageId },
      finished,
    ]),
    { headers: { "content-type": "text/event-stream" } },
  );
}

/** The source the carried turn saves before it builds the PDF. */
const SAVED = "report.tex";
/** The run the server carried the turn on in, once the one this browser started had stopped. */
const CARRIED_RUN = "carried-on";

/**
 * A turn the server carries to its answer while this browser sleeps. The server runs the Bot's
 * computer steps itself, in the run: this browser hears the run start, the Bot say what it will do,
 * the file it saved with the server's result, and the build asked for; then nothing. That run stopped
 * part way, its server gone, and another server carried the turn on in a run of its own, which ran
 * the build and answered. The thread holds all of it.
 */
function carriedRun(input: {
  threadId: string;
  runId: string;
  messages: unknown[];
}): Response {
  scene.runs = (scene.runs ?? 0) + 1;
  const person = input.messages.filter(
    (message) => (message as { role?: string }).role === "user",
  );
  const save = {
    id: "save",
    type: "function",
    function: {
      name: "computer_write_file",
      arguments: JSON.stringify({
        path: SAVED,
        contents: "\\documentclass{article}",
      }),
    },
  };
  const build = {
    id: "build",
    type: "function",
    function: {
      name: "computer_run_command",
      arguments: JSON.stringify({ command: COMMAND }),
    },
  };
  const saved = JSON.stringify({ ok: true, path: SAVED, bytes: 23 });
  scene.stored = [
    ...person,
    { id: "about", role: "assistant", content: ABOUT_TO, toolCalls: [save] },
    { id: "result-save", role: "tool", toolCallId: "save", content: saved },
    { id: "builds", role: "assistant", content: "", toolCalls: [build] },
    {
      id: "result-build",
      role: "tool",
      toolCallId: "build",
      content: JSON.stringify({
        ok: true,
        exitCode: 0,
        stdout: PRINTED,
        stderr: "",
      }),
    },
    { id: "done", role: "assistant", content: FINISHED_REPORT },
  ];
  // The run this browser started keeps no ending: its server stopped before writing one.
  scene.endings.set(CARRIED_RUN, {
    outcome: "succeeded",
    endedAt: new Date().toISOString(),
  });
  const heard = [
    { type: "RUN_STARTED", threadId: input.threadId, runId: input.runId },
    { type: "TEXT_MESSAGE_START", messageId: "about", role: "assistant" },
    { type: "TEXT_MESSAGE_CONTENT", messageId: "about", delta: ABOUT_TO },
    { type: "TEXT_MESSAGE_END", messageId: "about" },
    {
      type: "TOOL_CALL_START",
      toolCallId: "save",
      toolCallName: "computer_write_file",
      parentMessageId: "about",
    },
    {
      type: "TOOL_CALL_ARGS",
      toolCallId: "save",
      delta: save.function.arguments,
    },
    { type: "TOOL_CALL_END", toolCallId: "save" },
    {
      type: "TOOL_CALL_RESULT",
      messageId: "result-save",
      toolCallId: "save",
      role: "tool",
      content: saved,
    },
    {
      type: "TOOL_CALL_START",
      toolCallId: "build",
      toolCallName: "computer_run_command",
      parentMessageId: "builds",
    },
  ];
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(frames(heard)));
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
}

const json = (body: unknown, status = 200) =>
  Response.json(body, {
    status,
    headers: { "cache-control": "private, no-store" },
  });
const frames = (events: unknown[]) =>
  events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");

/** The run: its start and half its reply reach the browser; the rest never does. */
function run(input: {
  threadId: string;
  runId: string;
  messages: unknown[];
}): Response {
  const messageId = `reply-${input.runId}`;
  const said = scene.ends === "finished" ? WHOLE : HEAD;
  scene.stored = [
    ...input.messages.filter(
      (message) => (message as { role?: string }).role === "user",
    ),
    { id: messageId, role: "assistant", content: said },
  ];
  scene.endings.set(input.runId, {
    outcome: scene.ends === "finished" ? "succeeded" : "failed",
    endedAt: new Date().toISOString(),
  });
  const heard = [
    { type: "RUN_STARTED", threadId: input.threadId, runId: input.runId },
    { type: "TEXT_MESSAGE_START", messageId, role: "assistant" },
    { type: "TEXT_MESSAGE_CONTENT", messageId, delta: HEAD },
  ];
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(frames(heard)));
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
}

/** What the server answers at the API's and the runtime's addresses. */
async function answer(request: Request): Promise<Response | undefined> {
  const path = new URL(request.url).pathname;
  if (path === "/api/copilotkit/info")
    return json({
      version: "fixture",
      agents: { [BOT_ID]: { description: "Fixture", capabilities: {} } },
      mode: "sse",
      telemetryDisabled: true,
    });
  /*
   * Nothing has run in the conversation when it opens: nothing to replay. Joined once the carried
   * turn is over, the thread's last run is replayed: the server's, with the thread as it stands.
   */
  if (path.endsWith("/connect"))
    return new Response(
      scene.ends === "carried" && scene.runs
        ? frames([
            { type: "RUN_STARTED", threadId: THREAD, runId: CARRIED_RUN },
            { type: "MESSAGES_SNAPSHOT", messages: scene.stored },
            { type: "RUN_FINISHED", threadId: THREAD, runId: CARRIED_RUN },
          ])
        : "",
      { headers: { "content-type": "text/event-stream" } },
    );
  if (path.endsWith("/run"))
    return scene.ends === "onStep"
      ? stepRun(await request.json())
      : scene.ends === "carried"
        ? carriedRun(await request.json())
        : run(await request.json());
  // A command a Bot asked for, taken through the server's gate, which runs it and answers.
  if (path === `${ORGANIZATION}/people/me/computer-steps`) {
    scene.steps = (scene.steps ?? 0) + 1;
    return json({
      outcome: "done",
      result: { ok: true, exitCode: 0, stdout: PRINTED, stderr: "" },
    });
  }
  if (path.startsWith(`${ORGANIZATION}/people/me/approval-modes/`))
    return json({ asksEveryStep: false });
  if (/\/agent\/[^/]+\/stop\//.test(path)) return json({ stopped: true });
  if (path === BOT_PATH) return json({ bot: BOT });
  if (path === `${ORGANIZATION}/bots`)
    return json({ bots: [BOT], nextCursor: null });
  if (path === `${BOT_PATH}/grants`) return json(botGrantsBody());
  if (path === `${BOT_PATH}/components`)
    return json({ components: [], nextCursor: null });
  if (path === `${ORGANIZATION}/people/me/capabilities`)
    return json({ capabilities: {}, enforced: false });
  if (path === `${ORGANIZATION}/people/me`)
    return json({
      person: personBody({
        id: "sam",
        name: "Sam Rivera",
        email: "sam.rivera@northwind.example",
        role: "member",
      }),
      openbotVersion: "v1.2.0",
    });
  if (path === `${ORGANIZATION}/deployment`)
    return json({
      generativeUi: true,
      selfHostBanner: false,
      localEvaluation: false,
      edition: "team",
      authProviders: [],
      ssoConfigured: false,
      ssoRequired: false,
    });
  if (/\/conversations\/[^/]+\/(activity|signal-busy)$/.test(path))
    return new Response(null, { status: 204 });
  if (/\/conversations\/[^/]+\/voice-sessions$/.test(path))
    return json({ sessions: [], nextCursor: null });
  if (/\/conversations\/[^/]+\/refused-turns$/.test(path))
    return json({ refusedTurns: [], nextCursor: null });
  // Asked once the run has gone quiet: the conversation has no run going.
  if (path === `${ORGANIZATION}/conversations/${CONVERSATION}/join-tokens`)
    return json(
      {
        joinToken: "jt",
        expiresAt: "2026-11-25T18:20:30.000Z",
        threadId: THREAD,
        runId: null,
        realtime: { clientUrl: "ws://127.0.0.1/client", topic: "thread" },
      },
      201,
    );
  // How the run ended, as getConversationRun answers.
  const ran = path.match(
    new RegExp(`^${ORGANIZATION}/conversations/${CONVERSATION}/runs/([^/]+)$`),
  );
  if (ran) {
    const runId = decodeURIComponent(ran[1] ?? "");
    const ending = scene.endings.get(runId);
    if (ending) return json({ run: { id: runId, ...ending } });
    return Response.json(
      {
        type: "https://open.bot/errors/conversation-run-not-found",
        title: "Run not found.",
        status: 404,
        detail: "Couldn't find that run in this conversation.",
        code: "CONVERSATION_RUN_NOT_FOUND",
        category: "not_found",
        retryable: false,
      },
      {
        status: 404,
        headers: { "content-type": "application/problem+json" },
      },
    );
  }
  if (/\/threads\/[^/]+\/messages$/.test(path))
    return json({ messages: scene.stored });
  return undefined;
}

/** The fixture bundled for the browser. `@/lib/marks` is Vite's `import.meta.glob`, so no marks. */
async function bundle(): Promise<string> {
  const built = await Bun.build({
    entrypoints: [join(import.meta.dir, "run-ended-unheard.fixture.tsx")],
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
let server: Server<undefined> | undefined;
let origin = "";

beforeAll(async () => {
  if (!asked) return;
  const script = await bundle();
  const inter = join(packageDir("@fontsource-variable/inter"), "files");
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    // A run's stream stays open while the Bot thinks, as the runtime's does.
    idleTimeout: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/conversation.js")
        return new Response(script, {
          headers: { "content-type": "text/javascript" },
        });
      const font = join(inter, path.split("/").pop() ?? "");
      if (path.startsWith("/files/") && existsSync(font))
        return new Response(Bun.file(font));
      if (path.startsWith("/api/"))
        return (await answer(request)) ?? json({ detail: "Not found." }, 404);
      const theme = new URL(request.url).searchParams.get("theme") ?? "light";
      return new Response(
        `<!doctype html><html lang="en" class="${theme}" style="color-scheme: ${theme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head><body><div id="root"></div><script type="module" src="/conversation.js"></script></body></html>`,
        { headers: { "content-type": "text/html" } },
      );
    },
  });
  origin = `http://127.0.0.1:${server.port}`;
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
  await server?.stop(true);
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

/** The conversation, with the person's question sent and its run gone quiet after half a reply. */
async function sent(
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
  await page.goto(
    `${origin}/channel/${CONVERSATION}?quietMs=400&theme=${theme}`,
  );
  const box = page.getByRole("textbox", { name: "Message" });
  await box.waitFor({ timeout: 15_000 });
  await style(page);
  await box.click();
  await page.keyboard.type(ASKED);
  await page.getByRole("button", { name: "Send message" }).click();
  return page;
}

async function shoot(page: Page, name: string) {
  await style(page);
  await page.evaluate(() => document.fonts.ready);
  await still(page);
  if (!shots) return;
  mkdirSync(shots, { recursive: true });
  await page.screenshot({ path: join(shots, `${name}.png`) });
}

describe.skipIf(!asked)("a run whose end never reached this browser", () => {
  for (const engine of engines)
    for (const theme of ["light", "dark"] as const)
      for (const window of [
        { width: 1440, height: 900 },
        { width: 390, height: 844 },
      ]) {
        test(`that finished shows the whole reply with no notice, in ${engine}, ${theme}, ${window.width}px`, async () => {
          scene = { ends: "finished", stored: [], endings: new Map() };
          const page = await sent(engine, theme, window);
          try {
            await page.getByText(WHOLE).waitFor({ timeout: 15_000 });
            await page
              .getByRole("button", { name: "Stop the Bot" })
              .waitFor({ state: "detached", timeout: 15_000 });
            await shoot(
              page,
              `run-ended-unheard-finished-${engine}-${theme}-${window.width}`,
            );
            expect(await page.getByTestId("transcript-stopped").count()).toBe(
              0,
            );
            expect(await page.getByText(RUN_ENDED_UNHEARD).count()).toBe(0);
            expect(
              await page.getByRole("button", { name: "Carry on" }).count(),
            ).toBe(0);
            expect(
              await page.evaluate(
                () => document.documentElement.scrollWidth > innerWidth,
              ),
            ).toBe(false);
          } finally {
            await page.close();
          }
        }, 90_000);

        test(`that finished on a command it never heard carries on and runs it, in ${engine}, ${theme}, ${window.width}px`, async () => {
          scene = { ends: "onStep", stored: [], endings: new Map() };
          const page = await sent(engine, theme, window);
          try {
            await page.getByText(FINISHED_REPORT).waitFor({ timeout: 30_000 });
            await page
              .getByRole("button", { name: "Stop the Bot" })
              .waitFor({ state: "detached", timeout: 15_000 });
            // The command ran here once, and its step says what ran and what it printed.
            expect(scene.steps).toBe(1);
            expect(scene.runs).toBe(3);
            const step = page
              .locator("details")
              .filter({
                has: page.locator(":scope > summary", {
                  hasText: "Ran a command",
                }),
              })
              .last();
            await step.locator(":scope > summary").click();
            await page.getByText(PRINTED).first().waitFor({ timeout: 10_000 });
            await shoot(
              page,
              `run-ended-unheard-on-step-${engine}-${theme}-${window.width}`,
            );
            expect(await page.getByTestId("transcript-stopped").count()).toBe(
              0,
            );
            expect(await page.getByText(RUN_ENDED_UNHEARD).count()).toBe(0);
            expect(
              await page.getByRole("button", { name: "Carry on" }).count(),
            ).toBe(0);
            // The command the phone never ran reads as not run, never as blocked.
            expect(await page.getByText("Didn't run a command").count()).toBe(
              1,
            );
            expect(await page.getByText(/Blocked/).count()).toBe(0);
            expect(
              await page.evaluate(
                () => document.documentElement.scrollWidth > innerWidth,
              ),
            ).toBe(false);
          } finally {
            await page.close();
          }
        }, 120_000);

        test(`that the server carried on to its answer shows every step it ran and the answer, with no notice, in ${engine}, ${theme}, ${window.width}px`, async () => {
          scene = { ends: "carried", stored: [], endings: new Map() };
          const page = await sent(engine, theme, window);
          try {
            await page.getByText(FINISHED_REPORT).waitFor({ timeout: 30_000 });
            await page
              .getByRole("button", { name: "Stop the Bot" })
              .waitFor({ state: "detached", timeout: 15_000 });
            // The file it saved, drawn from the server's result as a step this page took is.
            await page.getByText("Saved a file").first().waitFor();
            // The build the server ran, with what it printed, in the same terminal block.
            const step = page
              .locator("details")
              .filter({
                has: page.locator(":scope > summary", {
                  hasText: "Ran a command",
                }),
              })
              .last();
            await step.locator(":scope > summary").click();
            await page.getByText(PRINTED).first().waitFor({ timeout: 10_000 });
            await shoot(
              page,
              `run-ended-unheard-carried-${engine}-${theme}-${window.width}`,
            );
            expect(await page.getByTestId("transcript-stopped").count()).toBe(
              0,
            );
            expect(await page.getByText(RUN_ENDED_UNHEARD).count()).toBe(0);
            expect(
              await page.getByRole("button", { name: "Carry on" }).count(),
            ).toBe(0);
            // Nothing ran here, and the Bot was not asked again.
            expect(scene.steps ?? 0).toBe(0);
            expect(scene.runs).toBe(1);
            expect(
              await page.evaluate(
                () => document.documentElement.scrollWidth > innerWidth,
              ),
            ).toBe(false);
          } finally {
            await page.close();
          }
        }, 120_000);

        test(`that failed still says it stopped, with Carry on, in ${engine}, ${theme}, ${window.width}px`, async () => {
          scene = { ends: "fails", stored: [], endings: new Map() };
          const page = await sent(engine, theme, window);
          try {
            const stopped = page.getByTestId("transcript-stopped");
            await stopped.waitFor({ timeout: 15_000 });
            await shoot(
              page,
              `run-ended-unheard-failed-${engine}-${theme}-${window.width}`,
            );
            expect(await stopped.getByRole("alert").textContent()).toBe(
              RUN_ENDED_UNHEARD,
            );
            expect(
              await stopped.getByRole("button", { name: "Carry on" }).count(),
            ).toBe(1);
            const drawn = await stopped.evaluate((row) => {
              const rect = row.getBoundingClientRect();
              return {
                inside: rect.left >= 0 && rect.right <= innerWidth,
                sideways: document.documentElement.scrollWidth > innerWidth,
              };
            });
            expect(drawn).toEqual({ inside: true, sideways: false });
          } finally {
            await page.close();
          }
        }, 90_000);
      }
});
