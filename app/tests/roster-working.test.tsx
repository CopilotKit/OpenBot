import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
  Browser,
  BrowserType,
  Page,
  WebSocketRoute,
} from "playwright-core";
import { compile } from "tailwindcss";

/**
 * A conversation's row in the sidebar says Working for as long as its Bot works, subtasks and all,
 * and shows its time again once everything has finished.
 *
 * Reported on OpenBot Cloud: a Bot ran three subtasks after the person gave it Slack. The
 * conversation said "Working on 3 subtasks…"; its row in the list said "1m", as if it were done.
 * Giving the app read every query again, and the server's list says nothing of a turn running in
 * the person's browser, so the read put out the row the turn's busy event had lit.
 *
 * In a real browser, the real Conversations and Bots panels, kept live by the app's own socket hook,
 * which this test answers as the server does: the busy event the turn's start is echoed as, a read
 * of everything (what giving an app does), and the end. And a Bot that handed its work to a task,
 * whose own turn ended on "On it" while the task works on.
 *
 *   OPENBOT_APP_BROWSER=1 OPENBOT_APP_ENGINES=chromium,webkit bun test app/tests/roster-working.test.tsx
 *
 * Chromium always, WebKit too when `OPENBOT_APP_ENGINES` names it; light and dark. With
 * OPENBOT_APP_SHOTS=<dir> it saves each moment as roster-working-<engine>-<theme>-<screen>-<moment>.png.
 */
const asked = process.env.OPENBOT_APP_BROWSER === "1";
const shots = process.env.OPENBOT_APP_SHOTS;

const APP = join(import.meta.dir, "..");
const ORIGIN = "http://openbot.test";
const ORGANIZATION = "/api/v2/organizations/default";

const FOLLOW_UPS = "Tagged Meeting Follow-ups";

/** The person's conversations, the first one spoken in a minute ago, as the server lists them. */
function conversations(now: number) {
  const at = (minutesAgo: number) =>
    new Date(now - minutesAgo * 60_000).toISOString();
  return [
    { id: "followups", summary: FOLLOW_UPS, minutes: 1 },
    { id: "customers", summary: "Categorizing Customer Calls", minutes: 60 },
    { id: "hn", summary: "Hacker News Top Articles", minutes: 22 * 60 },
  ].map(({ id, summary, minutes }) => ({
    id,
    name: "Personal Assistant",
    botIds: ["assistant"],
    threadId: `thread-${id}`,
    active: true,
    lastMessageAt: at(minutes),
    summary,
    opening: null,
    lastMessage: "Slack is ready now. Please carry on.",
    lastMessageBotId: null,
    createdAt: at(minutes + 5),
    pinned: false,
    lastReadAt: at(minutes),
    canRename: true,
    task: false,
    // No `busy`: the server holds no row that says a turn in the person's browser is running.
    work: [],
  }));
}

/** A task the Bot handed out of the first conversation, as the task list answers it. */
function task(status: string, now: number) {
  return {
    id: "task-1",
    botId: "assistant",
    conversationId: "task-conversation",
    threadId: "task-thread",
    title: "Find the prospect follow-ups",
    why: null,
    origin: "delegated",
    suggestionId: null,
    sourceApp: null,
    sourceLink: null,
    originConversationId: "followups",
    status,
    failure: null,
    failedAt: null,
    next: null,
    resolvedAt: null,
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
  };
}

async function bundle(): Promise<string> {
  const built = await Bun.build({
    entrypoints: [join(import.meta.dir, "roster-working.fixture.tsx")],
    target: "browser",
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
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

let script: string;
let css: string;
const engines: [string, Browser][] = [];

beforeAll(async () => {
  if (!asked) return;
  script = await bundle();
  // Every class the sidebar can draw, read from its source.
  const sources = [
    ...["ui", "layout", "app-sidebar"].flatMap((dir) =>
      readdirSync(join(APP, "src", "components", dir))
        .filter((file) => file.endsWith(".tsx"))
        .map((file) => `components/${dir}/${file}`),
    ),
    "components/agents/bot-orb.tsx",
    "components/channels/avatar.tsx",
    "../tests/roster-working.fixture.tsx",
  ].flatMap((file) =>
    readFileSync(join(APP, "src", file), "utf8").split(/[\s"'`]+/),
  );
  css = await stylesheet([...new Set(sources)].sort());
  const { chromium, webkit } = await import("playwright-core");
  engines.push(["chromium", await chromium.launch({ channel: "chromium" })]);
  if ((process.env.OPENBOT_APP_ENGINES ?? "").includes("webkit"))
    engines.push(["webkit", await (webkit as BrowserType).launch()]);
});

afterAll(async () => {
  for (const [, browser] of engines) await browser.close();
});

/** What the server holds while a test runs, and how many times the list has been read. */
type Server = {
  socket: Promise<WebSocketRoute>;
  latest?: WebSocketRoute;
  tasks: unknown[];
  listReads: number;
  now: number;
};

async function open(
  browser: Browser,
  theme: "light" | "dark",
  screen: "conversations" | "bots",
): Promise<{ page: Page; server: Server }> {
  const page = await browser.newPage({
    viewport: { width: 900, height: 640 },
    deviceScaleFactor: 2,
    colorScheme: theme,
  });
  page.on("pageerror", (error) => console.error(error));
  page.on("console", (message) => {
    // A read the fixture does not answer is a 404, and says so; anything else is worth reading.
    if (
      message.type() === "error" &&
      !message.text().startsWith("Failed to load resource")
    )
      console.error(message.text());
  });
  let connected: (socket: WebSocketRoute) => void = () => {};
  const server: Server = {
    socket: new Promise((resolve) => {
      connected = resolve;
    }),
    tasks: [],
    listReads: 0,
    now: Date.now(),
  };
  await page.routeWebSocket(/conversation-events/, (socket) => {
    // The latest one the app opened: an effect that ran again closed the one before.
    server.latest = socket;
    connected(socket);
  });
  const inter = join(packageDir("@fontsource-variable/inter"), "files");
  await page.route(`${ORIGIN}/**`, (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    if (path === "/")
      return route.fulfill({
        contentType: "text/html",
        body: `<!doctype html><html lang="en"><head><meta charset="utf-8"><style>${css}</style></head><body class="bg-background text-foreground"><div id="root"></div><script type="module" src="/shell.js"></script></body></html>`,
      });
    if (path === "/shell.js")
      return route.fulfill({ contentType: "text/javascript", body: script });
    const font = join(inter, path.split("/").pop() ?? "");
    if (path.startsWith("/files/") && existsSync(font))
      return route.fulfill({ path: font });
    if (path === `${ORGANIZATION}/conversations`) {
      server.listReads += 1;
      return route.fulfill({
        json: { conversations: conversations(server.now), nextCursor: null },
      });
    }
    if (path === `${ORGANIZATION}/tasks`)
      return route.fulfill({ json: { tasks: server.tasks, nextCursor: null } });
    if (path === `${ORGANIZATION}/bots`)
      return route.fulfill({
        json: {
          bots: [
            {
              id: "assistant",
              name: "Personal Assistant",
              title: "",
              roleDescription: "",
              avatarSeed: "Personal Assistant",
              lastConversationAt: new Date(server.now).toISOString(),
            },
          ],
          nextCursor: null,
        },
      });
    if (path === `${ORGANIZATION}/people/me/bot-attention`)
      return route.fulfill({
        json: { attention: [], lastPingId: null, nextCursor: null },
      });
    return route.fulfill({ status: 404, json: { detail: "Not found." } });
  });
  const search = new URLSearchParams({ screen, theme });
  await page.goto(`${ORIGIN}/?${search}`);
  await page.getByText(FOLLOW_UPS).first().waitFor();
  await page.evaluate(() => document.fonts.ready);
  const opened = await Promise.race([
    server.socket.then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 5_000)),
  ]);
  if (!opened)
    throw new Error("The app never opened its conversations socket.");
  return { page, server };
}

/** What the first conversation's row says where its time goes: "Working", or its time. */
async function rowSays(page: Page): Promise<string> {
  const row = page.locator('a[href="/channel/followups"]').first();
  return (await row.innerText()).replace(/\s+/g, " ").trim();
}

/** Send what the server says on the conversations socket. */
async function say(server: Server, event: Record<string, unknown>) {
  await server.socket;
  const socket = server.latest;
  if (!socket) throw new Error("No socket to speak on.");
  socket.send(
    JSON.stringify({
      lastMessage: null,
      lastMessageAt: null,
      lastMessageAgentId: null,
      organizationId: "default",
      ...event,
    }),
  );
}

/**
 * Wait until the row says `has`, then a moment more so nothing settles it back. When it never does,
 * the screen as it was is saved as `<name>-not-settled` before the test fails.
 */
async function settlesOn(page: Page, has: RegExp, name: string) {
  try {
    await page.waitForFunction(
      (source) => {
        const row = document.querySelector<HTMLElement>(
          'a[href="/channel/followups"]',
        );
        // As drawn: `textContent` runs the title into the time ("Follow-ups1m").
        return new RegExp(source).test(row?.innerText ?? "");
      },
      has.source,
      { timeout: 10_000 },
    );
  } catch (error) {
    await shot(page, `${name}-not-settled`);
    throw error;
  }
  await page.waitForTimeout(400);
  expect(await rowSays(page)).toMatch(has);
}

async function shot(page: Page, name: string) {
  if (!shots) return;
  mkdirSync(shots, { recursive: true });
  await page.screenshot({ path: join(shots, `roster-working-${name}.png`) });
}

/** The list read again by everything being read again, and landed. */
async function readEverything(page: Page, server: Server) {
  const before = server.listReads;
  await page.evaluate(() => window.readEverything?.());
  const deadline = Date.now() + 10_000;
  while (server.listReads === before && Date.now() < deadline)
    await page.waitForTimeout(50);
  expect(server.listReads).toBeGreaterThan(before);
  // Let the read land, and the read once more a patch mid-read asks for.
  await page.waitForTimeout(600);
}

const WORKING = /Working/;
const ONE_MINUTE = /\b1m\b/;

describe.skipIf(!asked)("a conversation's row while its Bot works", () => {
  for (const theme of ["light", "dark"] as const)
    for (const screen of ["conversations", "bots"] as const)
      test(`stays Working through a read of everything, and shows its time once done (${theme}, ${screen})`, async () => {
        for (const [engine, browser] of engines) {
          const { page, server } = await open(browser, theme, screen);
          const name = `${engine}-${theme}-${screen}`;
          // Waited for: on a loaded runner the row can be on the page before it is drawn.
          await settlesOn(page, ONE_MINUTE, `${name}-before`);
          await shot(page, `${name}-before`);

          // The person's turn starts in this conversation, and the server tells every tab.
          await say(server, {
            channelId: "followups",
            busy: true,
            work: [],
            workAt: new Date().toISOString(),
          });
          await settlesOn(page, WORKING, `${name}-turn-started`);

          // Slack given: every query is read again, while the Bot's subtasks run.
          await readEverything(page, server);
          await settlesOn(page, WORKING, `${name}-while-subtasks-run`);
          await shot(page, `${name}-while-subtasks-run`);

          // Every subtask done, the answer said, the turn over.
          await say(server, {
            channelId: "followups",
            busy: false,
            work: [],
            workAt: new Date().toISOString(),
          });
          await settlesOn(page, ONE_MINUTE, `${name}-turn-ended`);
          await readEverything(page, server);
          await settlesOn(page, ONE_MINUTE, `${name}-after-subtasks-finish`);
          await shot(page, `${name}-after-subtasks-finish`);
          await page.close();
        }
      }, 120_000);

  for (const theme of ["light", "dark"] as const)
    test(`a conversation whose Bot handed work to a task says Working until the task is done (${theme})`, async () => {
      for (const [engine, browser] of engines) {
        const { page, server } = await open(browser, theme, "conversations");
        const name = `${engine}-${theme}-conversations`;

        // The Bot hands the work to a task and its own turn ends on "On it".
        server.tasks = [task("working", server.now)];
        await say(server, {
          channelId: "followups",
          work: [],
          workAt: new Date().toISOString(),
        });
        await settlesOn(page, WORKING, `${name}-while-task-works`);
        await shot(page, `${name}-while-task-works`);

        // The task finishes and reports back.
        server.tasks = [task("ready_for_review", server.now)];
        await say(server, {
          channelId: "followups",
          work: [],
          workAt: new Date().toISOString(),
        });
        await settlesOn(page, ONE_MINUTE, `${name}-after-task-finishes`);
        await shot(page, `${name}-after-task-finishes`);
        await page.close();
      }
    }, 120_000);
});
