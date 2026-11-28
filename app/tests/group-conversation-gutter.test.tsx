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
  conversationPath,
  ORGANIZATION_PATH,
} from "./conversations-api";
import { still } from "./page-still";
import { test } from "./renderer-crash";

/**
 * A conversation with two Bots keeps the same side margin as a conversation with one.
 *
 * Found on a phone (390 wide): in a group the "Thinking" line sat on the screen's left edge, the
 * person's message and the Bots' avatars touched the edges, and the message box ran from one edge
 * to the other. A conversation with one Bot kept 16px a side. The group drew its own columns and
 * neither had the side inset; it now draws the same two columns (`conversation-columns.tsx`).
 *
 * In a real browser, through the app's own routes (first-message-thinking.fixture.tsx): a
 * conversation with one Bot, a group answered by one Bot while the other thinks, and a group
 * whose Bots have not started yet. On a phone and in a wide window, every line of the transcript
 * and the message box sit inside the margin the conversation with one Bot keeps, and the
 * transcript's column and the message box are where that conversation's are.
 *
 *   OPENBOT_APP_BROWSER=1 OPENBOT_APP_ENGINES=chromium,webkit bun test app/tests/group-conversation-gutter.test.tsx
 *
 * Chromium by default; OPENBOT_APP_ENGINES=chromium,webkit adds WebKit, as CI runs it. With
 * OPENBOT_APP_SHOTS=<dir> each is saved as group-gutter-<conversation>-<engine>-<width>-<theme>.png.
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
  "A spring tide is the large tide that comes just after a new or full moon.";

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
  packageBotId: null,
};

const OTHER_BOT = {
  ...BOT,
  id: "moon-bot",
  name: "Moon Reader",
  title: "Almanac keeper",
};

/** The three conversations, by id: one Bot, and two groups. */
const SOLO = "solo";
/** Tide Clerk has answered; Moon Reader's run has started and it has said nothing yet. */
const ANSWERED = "pair-answered";
/** The person's message is in, and neither Bot has started on it. */
const WAITING = "pair-waiting";

const AT = "2026-11-27T10:00:00.000Z";

/** A group's lines as the API lists them, oldest first here and reversed when served. */
const GROUP_LINES: Record<string, object[]> = {
  [ANSWERED]: [
    {
      id: "asked",
      role: "person",
      personId: "dana",
      botId: null,
      text: QUESTION,
      status: "completed",
      createdAt: AT,
    },
    {
      id: "asked:tide",
      role: "bot",
      personId: "dana",
      botId: BOT.id,
      text: ANSWER,
      status: "completed",
      createdAt: AT,
    },
    {
      id: "asked:moon",
      role: "bot",
      personId: "dana",
      botId: OTHER_BOT.id,
      text: "",
      status: "running",
      createdAt: AT,
    },
  ],
  [WAITING]: [
    {
      id: "asked",
      role: "person",
      personId: "dana",
      botId: null,
      text: QUESTION,
      status: "completed",
      createdAt: AT,
    },
  ],
};

function conversationBody(id: string) {
  const group = id !== SOLO;
  return {
    id,
    name: group ? `${BOT.name}, ${OTHER_BOT.name}` : BOT.name,
    botIds: group ? [BOT.id, OTHER_BOT.id] : [BOT.id],
    threadId: `thread-${id}`,
    active: true,
    lastMessageAt: AT,
  };
}

/** What the server answers for the API and the runtime. */
function answer(path: string): Response {
  const json = (body: unknown, status = 200) => Response.json(body, { status });
  if (path === "/api/copilotkit/info")
    return json({
      version: "fixture",
      agents: { [BOT.id]: { description: "Fixture", capabilities: {} } },
      mode: "sse",
      telemetryDisabled: true,
    });
  for (const id of [ANSWERED, WAITING]) {
    if (path === conversationPath(id, "/members"))
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
    if (path === conversationPath(id, "/messages"))
      return json({
        // Sent just now: a person's message stays "Thinking" for a while, not forever.
        messages: GROUP_LINES[id]
          .map((line) => ({ ...line, createdAt: new Date().toISOString() }))
          .reverse(),
        nextCursor: null,
      });
  }
  const conversation = path.match(/\/conversations\/([^/]+)$/);
  if (conversation && [SOLO, ANSWERED, WAITING].includes(conversation[1]))
    return json({ conversation: conversationBody(conversation[1]) });
  if (path === CONVERSATIONS_PATH)
    return json({
      conversations: [SOLO, ANSWERED, WAITING].map((id) => ({
        ...conversationBody(id),
        summary: null,
        lastMessage: null,
        lastMessageBotId: null,
        createdAt: AT,
        pinned: false,
        lastReadAt: null,
      })),
      nextCursor: null,
    });
  if (/\/conversations\/[^/]+\/(activity|signal-busy)$/.test(path))
    return new Response(null, { status: 204 });
  if (/\/conversations\/[^/]+\/voice-sessions$/.test(path))
    return json({ sessions: [], nextCursor: null });
  if (path.endsWith(`/threads/thread-${SOLO}/messages`))
    return json({
      messages: [
        { id: "solo-asked", role: "user", content: QUESTION },
        { id: "solo-answer", role: "assistant", content: ANSWER },
      ],
    });
  if (path === `${ORGANIZATION_PATH}/bots`)
    return json({ bots: [BOT, OTHER_BOT], nextCursor: null });
  if (path === `${ORGANIZATION_PATH}/bots/${BOT.id}`) return json({ bot: BOT });
  if (path === `${ORGANIZATION_PATH}/bots/${OTHER_BOT.id}`)
    return json({ bot: OTHER_BOT });
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
    entrypoints: [join(import.meta.dir, "first-message-thinking.fixture.tsx")],
    target: "browser",
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
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

let server: ReturnType<typeof Bun.serve> | undefined;
let port = 0;
const browsers = new Map<string, Browser>();
let script: string;
let css: string;

function html(theme: string): string {
  return `<!doctype html><html lang="en" class="${theme}" style="color-scheme: ${theme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><style>${css}</style></head><body><div id="root"></div><script type="module" src="/screens.js"></script></body></html>`;
}

function reply(request: Request): Response {
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
  if (path.startsWith("/api/")) return answer(path);
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

/** A conversation, opened at its own address in a window this wide, with its lines drawn. */
async function open(
  engine: string,
  path: string,
  width: number,
  theme: Theme,
): Promise<Page> {
  const browser = browsers.get(engine);
  if (!browser) throw new Error(`no ${engine}`);
  const page = await browser.newPage({
    viewport: { width, height: width < 768 ? 844 : 900 },
    colorScheme: theme,
    reducedMotion: "reduce",
  });
  page.on("pageerror", (error) => console.error(error));
  await page.goto(`http://127.0.0.1:${port}${path}?theme=${theme}`);
  await page.getByRole("textbox", { name: "Message" }).waitFor();
  await page.getByText(QUESTION).first().waitFor();
  await still(page);
  return page;
}

type Box = { left: number; right: number };

/**
 * Where the transcript's column lets its lines go (inside its padding), where the message box is,
 * and every line of the transcript: each message, and each "Thinking".
 */
async function measured(page: Page) {
  return page.evaluate(() => {
    const box = (element: Element) => {
      const rect = element.getBoundingClientRect();
      return { left: rect.left, right: rect.right };
    };
    const column = [
      ...document.querySelectorAll("[data-transcript-column]"),
    ].find((element) => element.getClientRects().length > 0);
    const composer = document.querySelector('[data-slot="composer"]');
    if (!column || !composer) return null;
    const style = getComputedStyle(column);
    const rect = column.getBoundingClientRect();
    return {
      window: innerWidth,
      inside: {
        left: rect.left + Number.parseFloat(style.paddingLeft),
        right: rect.right - Number.parseFloat(style.paddingRight),
      },
      composer: box(composer),
      lines: [
        ...column.querySelectorAll('[data-slot="message"], [role="status"]'),
      ]
        .filter((line) => line.getClientRects().length > 0)
        .map((line) => ({
          text: (line.textContent ?? "").trim().slice(0, 30),
          ...box(line),
        })),
    };
  });
}

/** Whole pixels, so a sub-pixel of rounding between engines is not a difference. */
const round = ({ left, right }: Box) => ({
  left: Math.round(left),
  right: Math.round(right),
});

async function shoot(page: Page, name: string) {
  if (!shots) return;
  mkdirSync(shots, { recursive: true });
  await page.screenshot({ path: join(shots, `${name}.png`) });
}

const GROUPS = [
  { name: "a group with one Bot answered", id: ANSWERED },
  { name: "a group whose Bots have not started", id: WAITING },
] as const;

describe.skipIf(!asked)(
  "a group conversation keeps a conversation's side margin",
  () => {
    for (const engine of engines)
      for (const width of [390, 1440])
        test(`at ${width} wide, in ${engine}`, async () => {
          const solo = await open(engine, `/channel/${SOLO}`, width, "light");
          let one: Awaited<ReturnType<typeof measured>>;
          try {
            await shoot(solo, `group-gutter-one-bot-${engine}-${width}-light`);
            one = await measured(solo);
          } finally {
            await solo.close();
          }
          expect(one).not.toBeNull();
          if (!one) return;
          // The conversation with one Bot is the margin to keep: 16px a side on a phone (and on the
          // right its scrollbar's room too, where scrollbars take room, as on Linux and Windows).
          if (width === 390) {
            expect(round(one.inside).left).toBe(16);
            expect(round(one.inside).right).toBeLessThanOrEqual(374);
            expect(round(one.composer)).toEqual({ left: 16, right: 374 });
          }
          for (const group of GROUPS) {
            const page = await open(
              engine,
              `/group/${group.id}`,
              width,
              "light",
            );
            try {
              await shoot(
                page,
                `group-gutter-${group.id}-${engine}-${width}-light`,
              );
              const at = await measured(page);
              expect(at).not.toBeNull();
              if (!at) return;
              // The same column, inset the same, and the same message box.
              expect({
                group: group.name,
                inside: round(at.inside),
                composer: round(at.composer),
              }).toEqual({
                group: group.name,
                inside: round(one.inside),
                composer: round(one.composer),
              });
              // Every line inside that margin: none at the screen's edge.
              expect(at.lines.length).toBeGreaterThan(0);
              const outside = at.lines.filter(
                (line) =>
                  line.left < one.inside.left - 0.5 ||
                  line.right > one.inside.right + 0.5,
              );
              expect(outside).toEqual([]);
              expect(
                at.lines.some((line) => line.text.startsWith("Thinking")),
              ).toBe(true);
            } finally {
              await page.close();
            }
          }
        }, 120_000);
  },
);

describe.skipIf(!asked || !shots)("screenshots, light and dark", () => {
  for (const engine of engines)
    test(`each conversation, wide and on a phone, in ${engine}`, async () => {
      for (const width of [390, 1440])
        for (const theme of ["light", "dark"] as const)
          for (const [name, path] of [
            ["one-bot", `/channel/${SOLO}`],
            [ANSWERED, `/group/${ANSWERED}`],
            [WAITING, `/group/${WAITING}`],
          ] as const) {
            const page = await open(engine, path, width, theme);
            try {
              await shoot(
                page,
                `group-gutter-${name}-${engine}-${width}-${theme}`,
              );
            } finally {
              await page.close();
            }
          }
    }, 300_000);
});
