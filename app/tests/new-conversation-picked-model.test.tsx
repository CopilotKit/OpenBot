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
import {
  catalogueBody,
  MODEL_CATALOGUE_PATH,
  modelChoiceConversation,
} from "./models-api";
import { still } from "./page-still";
import { test } from "./renderer-crash";

/**
 * A MODEL PICKED IN A NEW CONVERSATION WITH NOBODY IN TO:, BEFORE OPENBOT HAS PICKED THE BOT.
 *
 * Reported from dogfooding: the new-message view (the sidebar's +) offered no model picker, which
 * kept a person from using OpenBot over another assistant when they wanted a particular model for a
 * job. Home already offered one. A new conversation offered it only with one Bot in To: that runs
 * on OpenBot's model; with To: empty, where OpenBot picks the Bot, there was none.
 *
 * Now nobody in To: is home's composer, picker included: it starts on the catalogue's default, and
 * the pick is saved with the conversation of the Bot OpenBot picks, before the first message runs.
 * A Bot that picks its own model saves nothing, and the person is told so, as home tells them.
 *
 * In a real browser, through the app's own routes (new-conversation-picked-model.fixture.tsx): the
 * new conversation, its picker and composer, the start sequence and the conversation it opens. Only
 * OpenBot's API and the Bot's run are the server below.
 *
 *   OPENBOT_APP_BROWSER=1 OPENBOT_APP_ENGINES=chromium,webkit bun test app/tests/new-conversation-picked-model.test.tsx
 *
 * Chromium by default; OPENBOT_APP_ENGINES=chromium,webkit adds WebKit, the engine OpenBot
 * Desktop's Mac window draws with, as CI runs it. With OPENBOT_APP_SHOTS=<dir> the screen is saved
 * as new-conversation-picked-model-<to>-<step>-<engine>-<width>-<theme>.png.
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
const QUESTION = "Summarise the quarter in one line.";
const ANSWER = "Revenue grew, and costs held steady.";

const bot = (id: string, name: string, runsOnOpenBotModel: boolean) => ({
  ...getGetBotResponseMock().bot,
  id,
  name,
  title: "Analyst",
  mine: true,
  canManage: true,
  systemOwned: false,
  hidden: false,
  visibility: "public" as const,
  runsOnOpenBotModel,
  packageBotId: null,
  defaultModel: null,
});

/** A Bot on OpenBot's own model: it takes the pick. The default Bot. */
const TERRA = bot("terra-bot", "Terra Bot", true);
/** A Bot connected from outside OpenBot: it picks its own model. */
const OUTSIDE = bot("outside-bot", "Outside Bot", false);
const ROSTER = [TERRA, OUTSIDE];

const CATALOGUE = {
  provider: "openai",
  source: "openai",
  exposure: "all",
  default: "gpt-5.5",
  choosable: true,
  models: [
    {
      id: "gpt-6.1-terra",
      label: "GPT-6.1 Terra",
      vendor: "openai",
      efforts: ["low", "medium", "high", "xhigh"],
      defaultEffort: "medium",
    },
    {
      id: "gpt-5.5",
      label: "GPT-5.5",
      vendor: "openai",
      efforts: ["low", "medium", "high"],
      defaultEffort: "medium",
    },
  ],
};

type Pick = { model: string | null; effort: string | null };

/** The Bot OpenBot picks for the next message. */
let routeTo = TERRA;
/** Every routing, start, save and run, in the order the server took them. */
let trail: string[] = [];
let made = 0;
/** The conversations made, by id: their Bot, their thread and the model pick saved for them. */
const conversations = new Map<
  string,
  { botId: string; threadId: string; pick: Pick }
>();

let port = 0;
let server: ReturnType<typeof Bun.serve> | undefined;

/** The run, streamed as the runtime streams it. */
function run(threadId: string, runId: string): Response {
  const messageId = `${runId}-answer`;
  return new Response(
    [
      { type: "RUN_STARTED", threadId, runId },
      { type: "TEXT_MESSAGE_START", messageId, role: "assistant" },
      { type: "TEXT_MESSAGE_CONTENT", messageId, delta: ANSWER },
      { type: "TEXT_MESSAGE_END", messageId },
      { type: "RUN_FINISHED", threadId, runId },
    ]
      .map((event) => `data: ${JSON.stringify(event)}\n\n`)
      .join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
}

function conversationBody(id: string) {
  const conversation = conversations.get(id);
  const owner = ROSTER.find((one) => one.id === conversation?.botId) ?? TERRA;
  return {
    id,
    name: owner.name,
    botIds: [owner.id],
    threadId: conversation?.threadId ?? `thread-${id}`,
    active: true,
    lastMessageAt: null,
  };
}

/** What the server answers for the API and the runtime. */
async function answer(request: Request, path: string): Promise<Response> {
  const json = (body: unknown, status = 200) => Response.json(body, { status });
  if (path === "/api/copilotkit/info")
    return json({
      version: "fixture",
      agents: Object.fromEntries(
        ROSTER.map((one) => [
          one.id,
          { description: "Fixture", capabilities: {} },
        ]),
      ),
      mode: "sse",
      telemetryDisabled: true,
    });
  if (/\/agent\/[^/]+\/run$/.test(path)) {
    const body = (await request.json()) as { threadId: string; runId: string };
    trail.push("run");
    return run(body.threadId, body.runId);
  }
  if (path === ROUTE_PATH && request.method === "POST") {
    const body = (await request.json()) as { botId?: string };
    // Recorded for a Bot the person named; picked by OpenBot for a message nobody was named for.
    if (!body.botId) trail.push("route");
    const to = ROSTER.find((one) => one.id === body.botId) ?? routeTo;
    return json({
      botId: to.id,
      name: to.name,
      reason: "matched",
      fallback: false,
      viaMention: false,
    });
  }
  if (path === CONVERSATIONS_PATH && request.method === "POST") {
    const body = (await request.json()) as { botIds: string[] };
    made += 1;
    const id = `conversation-${made}`;
    conversations.set(id, {
      botId: body.botIds[0] ?? TERRA.id,
      threadId: `thread-${made}`,
      pick: { model: null, effort: null },
    });
    trail.push("create");
    return json({ conversation: conversationBody(id) }, 201);
  }
  const chosen = modelChoiceConversation(path);
  if (chosen !== undefined) {
    const conversation = conversations.get(chosen);
    if (!conversation)
      return Response.json(
        { status: 404, detail: "Not found." },
        {
          status: 404,
          headers: { "content-type": "application/problem+json" },
        },
      );
    if (request.method === "PUT") {
      const pick = (await request.json()) as Pick;
      trail.push(`save ${pick.model} ${pick.effort}`);
      conversation.pick = { model: pick.model, effort: pick.effort };
    }
    return json(conversation.pick);
  }
  if (path === MODEL_CATALOGUE_PATH) return json(catalogueBody(CATALOGUE));
  const conversation = path.match(/\/conversations\/([^/]+)$/);
  if (conversation && conversations.has(conversation[1]))
    return json({ conversation: conversationBody(conversation[1]) });
  if (path === CONVERSATIONS_PATH)
    return json({ conversations: [], nextCursor: null });
  if (/\/conversations\/[^/]+\/(activity|signal-busy|mark-read)$/.test(path))
    return new Response(null, { status: 204 });
  if (/\/conversations\/[^/]+\/voice-sessions$/.test(path))
    return json({ sessions: [], nextCursor: null });
  if (/\/threads\/[^/]+\/messages$/.test(path)) return json({ messages: [] });
  if (path === `${ORGANIZATION_PATH}/bots`)
    return json({ bots: ROSTER, nextCursor: null });
  for (const one of ROSTER) {
    if (path === `${ORGANIZATION_PATH}/bots/${one.id}`)
      return json({ bot: one });
    // How the Bot works: on its own, so a Bot on OpenBot's model takes a pick.
    if (path === `${ORGANIZATION_PATH}/bots/${one.id}/delegation`)
      return json({
        botId: one.id,
        mode: "self",
        model: null,
        effort: null,
        instructions: "",
        agents: [
          {
            id: "bag_openbot",
            name: "OpenBot",
            description: "OpenBot's own agent.",
            kind: "openbot",
            available: true,
          },
        ],
        canManage: true,
      });
  }
  if (/\/bots\/[^/]+\/grants$/.test(path)) return json(botGrantsBody());
  if (/\/bots\/[^/]+\/components$/.test(path))
    return json({ components: [], nextCursor: null });
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

/** The fixture bundled for the browser. `@/lib/marks` is Vite's `import.meta.glob`, so no marks. */
async function bundle(): Promise<string> {
  const built = await Bun.build({
    entrypoints: [
      join(import.meta.dir, "new-conversation-picked-model.fixture.tsx"),
    ],
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

/** The app's stylesheet, built by Tailwind for every class the screens here can draw. */
async function stylesheet(): Promise<string> {
  const classes = [
    ...sources("components"),
    "routes/_authed/_app/channel/new.tsx",
    "routes/_authed/_app/channel/$channelId.tsx",
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

/** A fresh page on `path`, with nothing kept from another test, once its message box is there. */
async function open(
  engine: string,
  path: string,
  { theme = "light", width = 1440 }: { theme?: Theme; width?: number } = {},
): Promise<Page> {
  const browser = browsers.get(engine);
  if (!browser) throw new Error(`no ${engine}`);
  trail = [];
  routeTo = TERRA;
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

/** The composer's model picker, named for what it shows. */
function picker(page: Page, shows: string) {
  return page.getByRole("combobox", { name: `Model: ${shows}` });
}

/** Pick GPT-6.1 Terra at Extra high, starting from the catalogue's default. */
async function pickTerraExtraHigh(page: Page) {
  // The catalogue's default, at its own default effort, until the person picks.
  await picker(page, "GPT-5.5, thinking: Medium").click({ timeout: 5_000 });
  await page.getByRole("option", { name: "GPT-6.1 Terra" }).click();
  await page.getByRole("option", { name: "Extra high" }).click();
  await picker(page, "GPT-6.1 Terra, thinking: Extra high").waitFor();
}

/** Write the first message and send it. */
async function send(page: Page) {
  await page.getByRole("textbox", { name: "Message" }).click();
  await page.keyboard.type(QUESTION);
  await page.keyboard.press("Enter");
}

describe.skipIf(!asked)(
  "a model picked in a new conversation with nobody in To:",
  () => {
    for (const engine of engines) {
      test(`is saved with the conversation of the Bot OpenBot picks, before it runs (${engine})`, async () => {
        const page = await open(engine, "/channel/new");
        try {
          await still(page);
          await pickTerraExtraHigh(page);
          // Nothing is saved while there is no conversation, nor a Bot.
          expect(trail).toEqual([]);
          await send(page);
          await page.waitForURL(/\/channel\/conversation-\d+$/);
          const id = new URL(page.url()).pathname.split("/").pop() ?? "";
          // The conversation the Bot answers in opens on the pick, read back from the server.
          await picker(page, "GPT-6.1 Terra, thinking: Extra high").waitFor({
            timeout: 15_000,
          });
          await page
            .getByRole("log")
            .filter({ hasText: ANSWER })
            .waitFor({ timeout: 15_000 });
          expect(conversations.get(id)).toMatchObject({
            botId: TERRA.id,
            pick: { model: "gpt-6.1-terra", effort: "xhigh" },
          });
          // Saved after the conversation was made and before its first message ran.
          expect(trail.slice(0, 4)).toEqual([
            "route",
            "create",
            "save gpt-6.1-terra xhigh",
            "run",
          ]);
        } finally {
          await page.close();
        }
      }, 60_000);

      test(`is not saved for a Bot that picks its own model, and says so (${engine})`, async () => {
        const page = await open(engine, "/channel/new");
        try {
          await still(page);
          routeTo = OUTSIDE;
          await pickTerraExtraHigh(page);
          await send(page);
          await page
            .getByText(
              "Outside Bot picks its own model, so it doesn't use the one you picked.",
            )
            .waitFor({ timeout: 15_000 });
          await page.waitForURL(/\/channel\/conversation-\d+$/);
          await shoot(page, `new-conversation-picked-model-not-used-${engine}`);
          const id = new URL(page.url()).pathname.split("/").pop() ?? "";
          expect(conversations.get(id)).toMatchObject({
            botId: OUTSIDE.id,
            pick: { model: null, effort: null },
          });
          expect(trail.some((step) => step.startsWith("save"))).toBe(false);
        } finally {
          await page.close();
        }
      }, 60_000);
    }
  },
);

/** Save the page as it is now, styled and still. */
async function shoot(page: Page, name: string) {
  if (!shots) return;
  mkdirSync(shots, { recursive: true });
  await still(page);
  await page.screenshot({ path: join(shots, `${name}.png`) });
}

/** The new conversation as each kind of To: draws it: nobody (OpenBot picks), and one Bot. */
const TO = [
  { to: "nobody", path: "/channel/new" },
  { to: "one-bot", path: `/channel/new?agent=${TERRA.id}` },
] as const;

describe.skipIf(!asked || !shots)(
  "the new conversation's model picker, as it looks",
  () => {
    for (const engine of engines)
      for (const width of [1440, 390])
        for (const theme of ["light", "dark"] as const)
          for (const { to, path } of TO)
            test(`${to}, ${engine} ${width} ${theme}`, async () => {
              const page = await open(engine, path, { theme, width });
              const name = (step: string) =>
                `new-conversation-picked-model-${to}-${step}-${engine}-${width}-${theme}`;
              try {
                await shoot(page, name("1-open"));
                await picker(page, "GPT-5.5, thinking: Medium").click({
                  timeout: 5_000,
                });
                await page
                  .getByRole("option", { name: "GPT-6.1 Terra" })
                  .waitFor();
                await shoot(page, name("2-picker-open"));
                await page
                  .getByRole("option", { name: "GPT-6.1 Terra" })
                  .click();
                await page.getByRole("option", { name: "Extra high" }).click();
                await shoot(page, name("3-picked"));
                await send(page);
                await page
                  .getByRole("log")
                  .filter({ hasText: ANSWER })
                  .waitFor({ timeout: 15_000 });
                await shoot(page, name("4-conversation"));
              } finally {
                await page.close();
              }
            }, 60_000);
  },
);
