import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Server } from "bun";
import type { Browser, BrowserType, Page } from "playwright-core";
import { compile } from "tailwindcss";
import { getGetBotResponseMock } from "@/lib/api/generated/bots/bots.msw";
import { UNREADABLE_REPLY } from "@/lib/copilot/stopped-turn";
import { personBody } from "./accounts-api";
import { botGrantsBody } from "./bot-grants-api";
import { still } from "./page-still";

/**
 * What a person sees when a connected Bot gets something wrong, in a real browser.
 *
 * FOUND BY THE AG-UI CONFORMANCE SUITE, with a stock Microsoft Agent Framework agent on gpt-4o:
 *
 * - It called the bar chart with `labels` and `series` where the chart takes `points`. The person saw
 *   an empty chart, "There is no data to chart.", and the Bot was told the chart was on screen. Now
 *   the Bot is told which fields were wrong, and the person sees the chart couldn't be shown.
 * - Its adapter streamed a tool call's start twice, and the run ended in the AG-UI client's own
 *   words, which the conversation showed word for word. Now it says what happened, with Carry on.
 *
 * The real conversation is drawn in the app's frame with the gallery the app registers, bundled from
 * the fixture beside this file, with the app's stylesheet, against a real HTTP server on this machine
 * that answers at the API's and the runtime's addresses. The person types and sends with a real
 * keyboard and a real click.
 *
 *   OPENBOT_APP_BROWSER=1 bun test app/tests/connected-bot-mistakes-layout.test.tsx
 *
 * Chromium by default, as CI has it. OPENBOT_APP_ENGINES=chromium,webkit adds WebKit. With
 * OPENBOT_APP_SHOTS=<dir> each is saved as connected-bot-<scene>-<engine>-<theme>-<width>.png.
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
const BOT_ID = "stock-agent";
const CONVERSATION = "revenue-conversation";
const BOT_PATH = `${ORGANIZATION}/bots/${BOT_ID}`;

const ASKED = "Chart our quarterly revenue.";
const RETRIED = "I sent that chart in the wrong shape. I'll send it again.";
/** The AG-UI client refusing a stream that started one tool call twice, word for word. */
const RAW =
  "Cannot send 'TOOL_CALL_START' event: A tool call with ID 'call_0f3' is already in progress. Complete it with 'TOOL_CALL_END' first.";

const BOT = {
  ...getGetBotResponseMock().bot,
  id: BOT_ID,
  name: "Stock agent",
  mine: true,
  canManage: true,
  systemOwned: false,
  visibility: "private" as const,
};

type Scene = {
  kind: "chart" | "fails";
  runs: {
    messages: { role?: string; toolCallId?: string; content?: unknown }[];
  }[];
};
let scene: Scene = { kind: "chart", runs: [] };

const json = (body: unknown, status = 200) =>
  Response.json(body, {
    status,
    headers: { "cache-control": "private, no-store" },
  });
const frames = (events: unknown[]) =>
  events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
const sse = (events: unknown[]) =>
  new Response(frames(events), {
    headers: { "content-type": "text/event-stream" },
  });

/** A run, as the runtime streams it from the Bot. */
function run(input: {
  threadId: string;
  runId: string;
  messages: Scene["runs"][number]["messages"];
}): Response {
  scene.runs.push({ messages: input.messages });
  const ids = { threadId: input.threadId, runId: input.runId };
  const started = { type: "RUN_STARTED", ...ids };
  if (scene.kind === "fails")
    return sse([
      started,
      { type: "RUN_ERROR", message: RAW, code: "agent_error" },
    ]);
  if (scene.runs.length === 1) {
    const toolCallId = "chart";
    return sse([
      started,
      {
        type: "TOOL_CALL_START",
        toolCallId,
        toolCallName: "showBarChart",
        parentMessageId: `step-${input.runId}`,
      },
      {
        type: "TOOL_CALL_ARGS",
        toolCallId,
        delta: JSON.stringify({
          title: "Quarterly revenue",
          labels: ["Q1", "Q2", "Q3", "Q4"],
          series: [{ name: "Revenue", data: [120, 135, 160, 180] }],
        }),
      },
      { type: "TOOL_CALL_END", toolCallId },
      { type: "RUN_FINISHED", ...ids },
    ]);
  }
  const messageId = `reply-${input.runId}`;
  return sse([
    started,
    { type: "TEXT_MESSAGE_START", messageId, role: "assistant" },
    { type: "TEXT_MESSAGE_CONTENT", messageId, delta: RETRIED },
    { type: "TEXT_MESSAGE_END", messageId },
    { type: "RUN_FINISHED", ...ids },
  ]);
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
  if (path.endsWith("/connect"))
    return new Response("", {
      headers: { "content-type": "text/event-stream" },
    });
  if (path.endsWith("/run")) return run(await request.json());
  if (/\/agent\/[^/]+\/stop\//.test(path)) return json({ stopped: true });
  if (path === BOT_PATH) return json({ bot: BOT });
  if (path === `${ORGANIZATION}/bots`)
    return json({ bots: [BOT], nextCursor: null });
  if (path === `${BOT_PATH}/grants`) return json(botGrantsBody());
  // The Bot holds the bar chart, and may draw it.
  if (path === `${BOT_PATH}/components`)
    return json({
      components: [{ name: "showBarChart", description: "A bar chart." }],
      nextCursor: null,
    });
  if (path === `${BOT_PATH}/components/showBarChart/check`)
    return json({ allowed: true, reason: null });
  if (path === `${ORGANIZATION}/components/announce`)
    return json({ added: [] });
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
  if (/\/threads\/[^/]+\/messages$/.test(path)) return json({ messages: [] });
  return undefined;
}

/** The fixture bundled for the browser. `@/lib/marks` is Vite's `import.meta.glob`, so no marks. */
async function bundle(): Promise<string> {
  const built = await Bun.build({
    entrypoints: [join(import.meta.dir, "connected-bot-mistakes.fixture.tsx")],
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

/** The conversation, with the person's question sent. */
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
  await page.goto(`${origin}/channel/${CONVERSATION}?theme=${theme}`);
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

async function noSidewaysScroll(page: Page) {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
  ).toBe(false);
}

describe.skipIf(!asked)("a connected Bot's mistakes", () => {
  for (const engine of engines)
    for (const theme of ["light", "dark"] as const)
      for (const window of [
        { width: 1440, height: 900 },
        { width: 390, height: 844 },
      ]) {
        test(`a bar chart sent the wrong arguments shows it couldn't be drawn, in ${engine}, ${theme}, ${window.width}px`, async () => {
          scene = { kind: "chart", runs: [] };
          const page = await sent(engine, theme, window);
          try {
            await page.getByText(RETRIED).waitFor({ timeout: 15_000 });
            await shoot(
              page,
              `connected-bot-chart-${engine}-${theme}-${window.width}`,
            );
            expect(
              await page.getByText("There is no data to chart.").count(),
            ).toBe(0);
            const failed = page.getByTestId("component-failed");
            expect(await failed.textContent()).toContain(
              "Couldn't show the bar chart.",
            );
            const told = scene.runs[1]?.messages.find(
              (message) => message.toolCallId === "chart",
            )?.content;
            expect(String(told)).toMatch(/points: [^.]*expected array/);
            const drawn = await failed.evaluate((card) => {
              const rect = card.getBoundingClientRect();
              return rect.left >= 0 && rect.right <= innerWidth;
            });
            expect(drawn).toBe(true);
            await noSidewaysScroll(page);
          } finally {
            await page.close();
          }
        }, 90_000);

        test(`a run broken by a malformed stream says so plainly, with Carry on, in ${engine}, ${theme}, ${window.width}px`, async () => {
          scene = { kind: "fails", runs: [] };
          const page = await sent(engine, theme, window);
          try {
            const stopped = page.getByTestId("transcript-stopped");
            await stopped.waitFor({ timeout: 15_000 });
            await shoot(
              page,
              `connected-bot-fails-${engine}-${theme}-${window.width}`,
            );
            expect(await stopped.getByRole("alert").textContent()).toBe(
              UNREADABLE_REPLY,
            );
            expect(await page.getByText(/already in progress/).count()).toBe(0);
            expect(
              await stopped.getByRole("button", { name: "Carry on" }).count(),
            ).toBe(1);
            await noSidewaysScroll(page);
          } finally {
            await page.close();
          }
        }, 90_000);
      }
});
