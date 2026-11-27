import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Browser, BrowserType, Page } from "playwright-core";
import { compile } from "tailwindcss";
import { getGetBotResponseMock } from "@/lib/api/generated/bots/bots.msw";
import { personBody } from "./accounts-api";
import { botGrantsBody } from "./bot-grants-api";
import { still } from "./page-still";

/**
 * An unsent reply, and the files attached to it, stay with their conversation, in a real browser.
 *
 * Reported from OpenBot 1.2.0-rc.4 on a Mac: type a reply in a conversation and leave it unsent,
 * open another conversation in the sidebar, come back, and the box was empty with no warning. A
 * file attached to the reply had gone too.
 *
 * The real sidebar and the real conversation are drawn in the app's frame, bundled from the fixture
 * beside this file, with the app's stylesheet. The server's answers are routes here, uploads
 * included; the thread's gateway is a Phoenix socket served here. The person types with the
 * keyboard, attaches with the file picker and switches with real clicks on the sidebar, then
 * reloads the page.
 *
 *   OPENBOT_APP_BROWSER=1 bun test app/tests/composer-keeps-draft-browser.test.tsx
 *
 * Chromium by default, as CI has it. OPENBOT_APP_ENGINES=chromium,webkit adds WebKit. With
 * OPENBOT_APP_SHOTS=<dir> each step is saved as composer-keeps-draft-<step>-<engine>-<theme>.png.
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
const origin = () => `http://127.0.0.1:${port}`;
const ORGANIZATION = "/api/v2/organizations/default";
const PICTURE = readFileSync(join(APP, "src", "assets", "openbot-logo.png"));
const REPLY = "Go with the ledger direction, but warmer";

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

/** What one conversation's thread stored: a question and its answer. */
const THREADS: Record<string, { asked: string; answer: string }> = {
  "design-thread": {
    asked: "Give me three directions for the landing page.",
    answer:
      "Three directions for the landing page: the Ledger, the Key Cabinet and the Atlas.",
  },
  "notes-thread": {
    asked: "Notes from today?",
    answer: "Here are the notes.",
  },
};

let port = 0;
let server: ReturnType<typeof Bun.serve> | undefined;
/** Every upload and every removal the page asked the server for, per test. */
let uploads: string[] = [];
let removals: string[] = [];
const stored = new Map<
  string,
  { name: string; mimeType: string; bytes: ArrayBuffer }
>();

type Frame = [string | null, string | null, string, string, unknown];

/** The thread's finished turn, replayed, as the gateway does for a joined thread. */
function replay(
  threadId: string,
  send: (name: string, payload: unknown) => void,
) {
  const thread = THREADS[threadId];
  if (!thread) return;
  const run = `${threadId}-run`;
  const event = (seq: number, fields: Record<string, unknown>) => ({
    ...fields,
    threadId,
    runId: run,
    run_id: run,
    metadata: { cpki_event_id: `${threadId}-${seq}`, cpki_event_seq: seq },
  });
  const answerId = `${threadId}-answer`;
  for (const one of [
    event(0, { type: "RUN_STARTED" }),
    event(1, {
      type: "TEXT_MESSAGE_START",
      messageId: answerId,
      role: "assistant",
    }),
    event(2, {
      type: "TEXT_MESSAGE_CONTENT",
      messageId: answerId,
      delta: thread.answer,
    }),
    event(3, { type: "TEXT_MESSAGE_END", messageId: answerId }),
    event(4, { type: "RUN_FINISHED" }),
  ])
    send("ag_ui_event", one);
  send("replay_complete", { latestEventId: `${threadId}-4` });
  send("stream_idle", { latestEventId: `${threadId}-4` });
}

/** What the server answers for the API and the runtime. */
async function answer(
  request: Request,
  path: string,
): Promise<Response | undefined> {
  const upload = path.match(/\/conversations\/([^/]+)\/attachments$/);
  if (upload && request.method === "POST") {
    const form = await request.formData();
    const file = form.get("file") as File;
    const id = `stored-${stored.size + 1}`;
    uploads.push(file.name);
    stored.set(id, {
      name: file.name,
      mimeType: file.type || "application/octet-stream",
      bytes: await file.arrayBuffer(),
    });
    return Response.json(
      {
        id,
        name: file.name,
        mimeType: file.type || "application/octet-stream",
      },
      { status: 201 },
    );
  }
  const attachment = path.match(/\/attachments\/([^/]+)$/);
  if (attachment) {
    const id = decodeURIComponent(attachment[1]);
    if (request.method === "DELETE") {
      removals.push(id);
      stored.delete(id);
      return new Response(null, { status: 204 });
    }
    const file = stored.get(id);
    if (!file)
      return Response.json({ detail: "No such attachment." }, { status: 404 });
    return new Response(file.bytes, {
      headers: { "content-type": file.mimeType },
    });
  }
  const json = (body: unknown, status = 200) => Response.json(body, { status });
  if (path === "/api/copilotkit/info")
    return json({
      version: "fixture",
      agents: {
        "design-bot": { description: "Fixture", capabilities: {} },
        "notes-bot": { description: "Fixture", capabilities: {} },
      },
      mode: "intelligence",
      intelligence: { wsUrl: `ws://127.0.0.1:${port}/client` },
      telemetryDisabled: true,
    });
  const connect = path.match(/\/agent\/([^/]+)\/connect$/);
  if (connect) {
    const threadId =
      connect[1] === "design-bot" ? "design-thread" : "notes-thread";
    return json({
      threadId,
      runId: null,
      joinToken: "join-token",
      realtime: {
        clientUrl: `ws://127.0.0.1:${port}/client`,
        topic: `thread:${threadId}`,
      },
    });
  }
  const joinToken = path.match(/\/conversations\/([^/]+)\/join-tokens$/);
  if (joinToken) {
    const threadId =
      joinToken[1] === "design-conversation" ? "design-thread" : "notes-thread";
    return json(
      {
        joinToken: "join-token",
        expiresAt: new Date(Date.now() + 30_000).toISOString(),
        threadId,
        runId: null,
        realtime: {
          clientUrl: `ws://127.0.0.1:${port}/client`,
          topic: `thread:${threadId}`,
        },
      },
      201,
    );
  }
  const bot = path.match(/\/bots\/([^/]+)$/);
  if (bot) return json({ bot: bot[1] === "notes-bot" ? NOTES_BOT : BOT });
  if (path === `${ORGANIZATION}/bots`)
    return json({ bots: [BOT, NOTES_BOT], nextCursor: null });
  if (/\/bots\/[^/]+\/grants$/.test(path)) return json(botGrantsBody());
  if (/\/bots\/[^/]+\/components$/.test(path))
    return json({ components: [], nextCursor: null });
  if (/\/computers\/[^/]+\/control$/.test(path))
    return json({
      holder: "bot",
      since: "2026-11-23T20:00:00.000Z",
      requested: false,
    });
  if (path === `${ORGANIZATION}/people/me/capabilities`)
    return json({ capabilities: {}, enforced: false });
  if (path === `${ORGANIZATION}/people/me`)
    return json({
      person: personBody({
        id: "dana",
        name: "Dana Reyes",
        email: "dana.reyes@northwind.example",
        role: "admin",
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
  const thread = path.match(/\/threads\/([^/]+)\/messages$/);
  if (thread) {
    const threadId = decodeURIComponent(thread[1]);
    const said = THREADS[threadId];
    return json({
      messages: said
        ? [
            { id: `${threadId}-asked`, role: "user", content: said.asked },
            {
              id: `${threadId}-answer`,
              role: "assistant",
              content: said.answer,
            },
          ]
        : [],
    });
  }
  return undefined;
}

/** The fixture bundled for the browser. `@/lib/marks` is Vite's `import.meta.glob`, so no marks. */
async function bundle(): Promise<string> {
  const built = await Bun.build({
    entrypoints: [join(import.meta.dir, "composer-keeps-draft.fixture.tsx")],
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

function html(theme: string): string {
  return `<!doctype html><html lang="en" class="${theme}" style="color-scheme: ${theme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head><body><div id="root"></div><script type="module" src="/conversation.js"></script></body></html>`;
}

async function reply(request: Request): Promise<Response> {
  const url = new URL(request.url);
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
    return (
      (await answer(request, path)) ??
      Response.json({ detail: "Not found." }, { status: 404 })
    );
  }
  return new Response(html(url.searchParams.get("theme") ?? "light"), {
    headers: { "content-type": "text/html" },
  });
}

beforeAll(async () => {
  if (!asked) return;
  server = Bun.serve<{ open: boolean }>({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, bun) {
      if (request.headers.get("upgrade") === "websocket")
        return bun.upgrade(request, { data: { open: true } })
          ? undefined
          : new Response("upgrade failed", { status: 400 });
      return reply(request);
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
        replay(topic.replace(/^thread:/, ""), (event, payload) => {
          if (socket.data.open && socket.readyState === 1)
            socket.send(JSON.stringify([joinRef, null, topic, event, payload]));
        });
      },
    },
  });
  port = server.port ?? 0;
  script = await bundle();
  const playwright = await import("playwright-core");
  for (const engine of engines) {
    const type: BrowserType = playwright[engine];
    // The CI job installs full Chromium without the headless shell.
    browsers.set(
      engine,
      await type.launch(engine === "chromium" ? { channel: "chromium" } : {}),
    );
  }
}, 120_000);

afterAll(async () => {
  for (const browser of browsers.values()) await browser.close();
  server?.stop(true);
});

async function shoot(page: Page, step: string, name: string) {
  if (!shots) return;
  mkdirSync(shots, { recursive: true });
  const classes = await page.evaluate(() =>
    [...document.querySelectorAll("[class]")].flatMap((element) => [
      ...element.classList,
    ]),
  );
  await page.addStyleTag({ content: await stylesheet([...new Set(classes)]) });
  // The stylesheet lands after the page drew: the strip opens and the fonts load, then it is still.
  await still(page);
  await page.screenshot({
    path: join(shots, `composer-keeps-draft-${step}-${name}.png`),
  });
}

const message = (page: Page) =>
  page.locator('[contenteditable="true"][aria-label="Message"]');

/** The reply and both of its files are on the composer, the files finished uploading. */
async function draftShown(page: Page) {
  await page.getByRole("button", { name: "Remove brief.png" }).waitFor();
  await page.getByRole("button", { name: "Remove notes.txt" }).waitFor();
  expect(await message(page).innerText()).toContain(REPLY);
  // Send opens only once nothing is still uploading.
  await page.waitForFunction(
    () =>
      !(
        document.querySelector(
          '[data-slot="composer-send"]',
        ) as HTMLButtonElement | null
      )?.disabled,
  );
}

async function switchTo(page: Page, summary: string) {
  await page
    .getByRole("link", { name: new RegExp(summary) })
    .first()
    .click();
}

describe.skipIf(!asked)("an unsent reply stays with its conversation", () => {
  for (const engine of engines)
    for (const theme of ["light", "dark"] as const)
      test(`the reply and its files come back after switching and after a reload, in ${engine}, ${theme}`, async () => {
        uploads = [];
        removals = [];
        stored.clear();
        const browser = browsers.get(engine);
        if (!browser) throw new Error(`no ${engine}`);
        const context = await browser.newContext({
          viewport: { width: 1280, height: 800 },
          colorScheme: theme,
          reducedMotion: "reduce",
        });
        const page = await context.newPage();
        page.on("pageerror", (error) => console.error(error));
        const name = `${engine}-${theme}`;
        try {
          await page.goto(
            `${origin()}/channel/design-conversation?theme=${theme}`,
          );
          await page
            .getByText(THREADS["design-thread"].answer)
            .waitFor({ timeout: 15_000 });

          // Type a reply and attach a picture and a text file, and leave it unsent.
          await message(page).click();
          await page.keyboard.type(REPLY);
          await page.locator('input[type="file"]').setInputFiles([
            { name: "brief.png", mimeType: "image/png", buffer: PICTURE },
            {
              name: "notes.txt",
              mimeType: "text/plain",
              buffer: Buffer.from("Warmer palette."),
            },
          ]);
          await draftShown(page);
          await shoot(page, "1-typed", name);

          // Another conversation: its own box, empty.
          await switchTo(page, "Meeting notes");
          await page.getByText("Here are the notes.").first().waitFor();
          expect((await message(page).innerText()).trim()).toBe("");
          expect(
            await page.getByRole("button", { name: /^Remove / }).count(),
          ).toBe(0);
          await shoot(page, "2-other", name);

          // Back: the reply and both files, as they were left.
          await switchTo(page, "Three landing page directions");
          await draftShown(page);
          await shoot(page, "3-back", name);

          // A reload: still there.
          await page.reload();
          await page
            .getByText(THREADS["design-thread"].answer)
            .waitFor({ timeout: 15_000 });
          await draftShown(page);
          await shoot(page, "4-reloaded", name);

          // Each file went up once, and nothing gave a file back while the draft held it.
          expect(uploads.sort()).toEqual(["brief.png", "notes.txt"]);
          expect(removals).toEqual([]);
        } finally {
          await context.close();
        }
      }, 120_000);

  /*
   * The box with no conversation yet uploads nothing until the first message makes one, so its
   * files live only in this tab; a reload reads them back from the browser's own storage.
   */
  for (const engine of engines)
    test(`the first message's words and picked files come back after a reload, in ${engine}`, async () => {
      uploads = [];
      const browser = browsers.get(engine);
      if (!browser) throw new Error(`no ${engine}`);
      const context = await browser.newContext({
        viewport: { width: 1280, height: 800 },
        reducedMotion: "reduce",
      });
      const page = await context.newPage();
      page.on("pageerror", (error) => console.error(error));
      try {
        await page.goto(`${origin()}/home`);
        await message(page).click();
        await page.keyboard.type(REPLY);
        await page.locator('input[type="file"]').setInputFiles([
          { name: "brief.png", mimeType: "image/png", buffer: PICTURE },
          {
            name: "notes.txt",
            mimeType: "text/plain",
            buffer: Buffer.from("Warmer palette."),
          },
        ]);
        await draftShown(page);
        // Give the browser's storage its write before the page goes.
        await page.waitForTimeout(300);
        await page.reload();
        await draftShown(page);
        await shoot(page, "5-home-reloaded", engine);
        expect(uploads).toEqual([]);
      } finally {
        await context.close();
      }
    }, 120_000);
});
