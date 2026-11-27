import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ComputerControlState } from "@openbot/shared/computer-control";
import type { Server } from "bun";
import type { Browser, BrowserType, Locator, Page } from "playwright-core";
import { compile } from "tailwindcss";
import { getGetBotResponseMock } from "@/lib/api/generated/bots/bots.msw";
import { personBody } from "./accounts-api";
import { botGrantsBody } from "./bot-grants-api";
import { still } from "./page-still";

/**
 * A Bot that browses, and asks the person to take over its browser or for a password, on a phone and
 * on a wide screen, in a real browser.
 *
 * Found in the computer journeys at a phone's width: the Bot reached its computer, the Computer
 * opened itself, and on a narrow window it opens as a sheet over the whole conversation. The Bot
 * then stopped and asked the person to take over ("The Bot needs you", with Take control), and that
 * card sat in the conversation under the sheet, where the person could neither see it nor press it.
 * The Computer still opens itself while the Bot browses; a card that waits on the person closes it.
 *
 * The real conversation route is drawn in the app's frame, bundled from the fixture beside this
 * file, with the app's stylesheet, against a real HTTP server on this machine that answers at the
 * API's, the runtime's and the Bot's computer's addresses. The person types and sends with a real
 * keyboard and a real click.
 *
 *   OPENBOT_APP_BROWSER=1 bun test app/tests/computer-panel-phone-layout.test.tsx
 *
 * Chromium by default, as CI has it. OPENBOT_APP_ENGINES=chromium,webkit adds WebKit. With
 * OPENBOT_APP_SHOTS=<dir> each is saved as computer-panel-<step>-<engine>-<theme>-<width>.png.
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
const BOT_ID = "fernhill-member";
const CONVERSATION = "garden-conversation";
const BOT_PATH = `${ORGANIZATION}/bots/${BOT_ID}`;
const COMPUTER_PATH = `${ORGANIZATION}/computers/${BOT_ID}`;

const ASKED = "Sign in to my members' area and tell me my seed allowance.";
const SAYS = "I filled in your username. I need you for the password.";
const REASON = "Type your password on the sign-in page, then hand it back.";

const BOT = {
  ...getGetBotResponseMock().bot,
  id: BOT_ID,
  name: "Fernhill Member",
  mine: true,
  canManage: true,
  systemOwned: false,
  visibility: "private" as const,
};

const SINCE = "2026-11-26T18:00:00.000Z";
/** The Bot's computer's wheel, as the computer's control routes answer it. */
let control: ComputerControlState = botHolds();
function botHolds(): ComputerControlState {
  return {
    holder: "bot",
    since: SINCE,
    requested: false,
    transitioning: false,
    resumeSnapshotRequired: false,
    recoveryRequired: false,
  };
}
/** The thread as the runtime has stored it. */
let stored: unknown[] = [];
/**
 * What the Bot asks of the person: to take over its browser, or, once it has opened the sign-in
 * page, for the password in the masked box. Or nothing: it opens a page and answers.
 */
let asks: "takeOver" | "secret" | "nothing" = "takeOver";

const SECRET_LABEL = "your members' area password";
const MEMBERS = "https://fernhill.example/members";
const ANSWERED = "Your seed allowance is 12 packets this season.";

const json = (body: unknown, status = 200) =>
  Response.json(body, {
    status,
    headers: { "cache-control": "private, no-store" },
  });
const frames = (events: unknown[]) =>
  events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");

/** The tool call each run of the Bot makes, or none when it answers in words. */
function callOf(messages: unknown[]) {
  if (asks === "takeOver")
    return {
      id: "call-help",
      name: "computer_request_help",
      args: { reason: REASON },
    };
  // The sign-in page first; once it is open, the password in the masked box, or the answer.
  const opened = (messages.at(-1) as { role?: string } | undefined)?.role;
  if (opened !== "tool")
    return {
      id: "call-open",
      name: "computer_navigate",
      args: { url: MEMBERS },
    };
  return asks === "secret"
    ? {
        id: "call-secret",
        name: "computer_request_secret",
        args: { label: SECRET_LABEL, ref: "e7", snapshotId: 3 },
      }
    : null;
}

/** The Bot's run: a sentence, then the call that asks something of the person. */
function run(input: {
  threadId: string;
  runId: string;
  messages: unknown[];
}): Response {
  const messageId = `reply-${input.runId}`;
  const asked = callOf(input.messages);
  if (!asked) {
    stored = [
      ...input.messages,
      { id: messageId, role: "assistant", content: ANSWERED },
    ];
    return new Response(
      frames([
        { type: "RUN_STARTED", threadId: input.threadId, runId: input.runId },
        { type: "TEXT_MESSAGE_START", messageId, role: "assistant" },
        { type: "TEXT_MESSAGE_CONTENT", messageId, delta: ANSWERED },
        { type: "TEXT_MESSAGE_END", messageId },
        { type: "RUN_FINISHED", threadId: input.threadId, runId: input.runId },
      ]),
      { headers: { "content-type": "text/event-stream" } },
    );
  }
  const call = {
    id: asked.id,
    type: "function",
    function: { name: asked.name, arguments: JSON.stringify(asked.args) },
  };
  stored = [
    ...input.messages,
    { id: messageId, role: "assistant", content: SAYS, toolCalls: [call] },
  ];
  return new Response(
    frames([
      { type: "RUN_STARTED", threadId: input.threadId, runId: input.runId },
      { type: "TEXT_MESSAGE_START", messageId, role: "assistant" },
      { type: "TEXT_MESSAGE_CONTENT", messageId, delta: SAYS },
      { type: "TEXT_MESSAGE_END", messageId },
      {
        type: "TOOL_CALL_START",
        toolCallId: call.id,
        toolCallName: asked.name,
        parentMessageId: messageId,
      },
      {
        type: "TOOL_CALL_ARGS",
        toolCallId: call.id,
        delta: call.function.arguments,
      },
      { type: "TOOL_CALL_END", toolCallId: call.id },
      { type: "RUN_FINISHED", threadId: input.threadId, runId: input.runId },
    ]),
    { headers: { "content-type": "text/event-stream" } },
  );
}

/** The Bot's computer, answering as its control routes do. The person never takes over here. */
async function computer(
  route: string,
  request: Request,
): Promise<Response | undefined> {
  if (route === "") return json({ botId: BOT_ID, state: "ready" });
  if (route === "/control" && request.method === "GET") return json(control);
  if (route === "/control/request") {
    const body = (await request.json()) as {
      reason: string;
      toolCallId?: string;
    };
    control = {
      ...control,
      requested: true,
      reason: body.reason,
      request: {
        id: "request-1",
        ...(body.toolCallId ? { toolCallId: body.toolCallId } : {}),
        reason: body.reason,
        source: "model",
        status: "waiting",
        createdAt: SINCE,
        updatedAt: SINCE,
        expiresAt: "2026-11-26T18:10:00.000Z",
      },
    };
    return json(control);
  }
  if (route === "/navigate")
    return json({ ok: true, url: MEMBERS, title: "Members area" });
  if (route === "/control/secret") {
    const body = (await request.json()) as { label: string };
    control = { ...control, secretWanted: body.label, secretId: "secret-1" };
    return json(control);
  }
  return undefined;
}

/** What the server answers at the API's, the runtime's and the computer's addresses. */
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
  if (path.startsWith(COMPUTER_PATH))
    return computer(path.slice(COMPUTER_PATH.length), request);
  if (path.startsWith(`${ORGANIZATION}/people/me/approval-modes/`))
    return json({ asksEveryStep: false });
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
      botComputers: true,
    });
  if (/\/conversations\/[^/]+\/(activity|signal-busy)$/.test(path))
    return new Response(null, { status: 204 });
  if (/\/conversations\/[^/]+\/voice-sessions$/.test(path))
    return json({ sessions: [], nextCursor: null });
  if (/\/conversations\/[^/]+\/refused-turns$/.test(path))
    return json({ refusedTurns: [], nextCursor: null });
  if (/\/threads\/[^/]+\/messages$/.test(path))
    return json({ messages: stored });
  return undefined;
}

/** The fixture bundled for the browser. `@/lib/marks` is Vite's `import.meta.glob`, so no marks. */
async function bundle(): Promise<string> {
  const built = await Bun.build({
    entrypoints: [join(import.meta.dir, "computer-panel-phone.fixture.tsx")],
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

async function shoot(page: Page, name: string) {
  await style(page);
  await page.evaluate(() => document.fonts.ready);
  await still(page);
  if (!shots) return;
  mkdirSync(shots, { recursive: true });
  await page.screenshot({ path: join(shots, `${name}.png`) });
}

/** The conversation, with the person's question sent and the Bot asking something of them. */
async function asking(
  what: typeof asks,
  engine: string,
  theme: "light" | "dark",
  window: { width: number; height: number },
): Promise<Page> {
  const browser = browsers.get(engine);
  if (!browser) throw new Error(`no ${engine}`);
  asks = what;
  control = botHolds();
  stored = [];
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

/** The take-over card in the conversation. */
function card(page: Page): Locator {
  return page.locator('[data-help-request="call-help"]');
}

/** The masked box the Bot asks for a password in, which the Computer draws. */
function maskedBox(page: Page): Locator {
  return page.getByLabel(`The Bot needs ${SECRET_LABEL}`);
}

/**
 * Whether a person can see and press this: it is on screen and nothing lies over it, so a tap there
 * lands on it.
 */
async function reachable(target: Locator): Promise<boolean> {
  await target.scrollIntoViewIfNeeded();
  return target.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return false;
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    if (x < 0 || x > innerWidth || y < 0 || y > innerHeight) return false;
    const hit = document.elementFromPoint(x, y);
    return hit !== null && element.contains(hit);
  });
}

const PHONE = { width: 390, height: 844 };
const WIDE = { width: 1440, height: 900 };

/** Nothing sideways: the conversation fits the window it is in. */
const fits = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);

describe.skipIf(!asked)("a Bot asking something of the person", () => {
  for (const engine of engines)
    for (const theme of ["light", "dark"] as const) {
      test(`while the Bot browses, on a phone: the Computer still opens itself, in ${engine}, ${theme}`, async () => {
        const page = await asking("nothing", engine, theme, PHONE);
        try {
          const sheet = page.getByRole("dialog", { name: "Computer" });
          await sheet
            .getByRole("region", { name: "Computer sidebar" })
            .waitFor({ timeout: 20_000 });
          await shoot(page, `computer-panel-browsing-${engine}-${theme}-390`);
          // Closing it is the way back to the conversation and the Bot's answer.
          await sheet.getByRole("button", { name: "Close" }).click();
          await page
            .locator('[data-slot="sheet-content"]')
            .waitFor({ state: "detached" });
          await page.getByText(ANSWERED).waitFor({ timeout: 20_000 });
          expect(await reachable(page.getByText(ANSWERED))).toBe(true);
          expect(await fits(page)).toBe(true);
        } finally {
          await page.close();
        }
      }, 90_000);

      test(`to take over, on a phone: the Computer gives way to the card, and opens again when asked, in ${engine}, ${theme}`, async () => {
        const page = await asking("takeOver", engine, theme, PHONE);
        try {
          const takeOver = card(page).getByRole("button", {
            name: "Take control",
          });
          await card(page)
            .getByText("The Bot needs you.")
            .waitFor({ timeout: 20_000 });
          // Long enough for a Computer opening itself to have opened.
          await page.waitForTimeout(1_500);
          await shoot(page, `computer-panel-take-over-${engine}-${theme}-390`);
          // Nothing covers the conversation: the card is in view, and Take control is under the finger.
          expect(await page.getByRole("dialog").count()).toBe(0);
          expect(await reachable(takeOver)).toBe(true);
          expect(await fits(page)).toBe(true);
          // The Computer's button says the Bot needs the person.
          expect(
            await page
              .getByRole("button", { name: "Open Computer" })
              .getByRole("img", { name: "Needs you" })
              .count(),
          ).toBe(1);

          // Opened by the person, the Computer takes the screen, and closing it is the way back.
          await page.getByRole("button", { name: "Open Computer" }).click();
          const sheet = page.getByRole("dialog", { name: "Computer" });
          await sheet
            .getByRole("region", { name: "Computer sidebar" })
            .waitFor();
          // It stays open: the card that closed it once is not a new one.
          await page.waitForTimeout(1_500);
          expect(await sheet.isVisible()).toBe(true);
          await shoot(
            page,
            `computer-panel-take-over-opened-${engine}-${theme}-390`,
          );
          await sheet.getByRole("button", { name: "Close" }).click();
          // Gone once it has slid away.
          await page
            .locator('[data-slot="sheet-content"]')
            .waitFor({ state: "detached" });
          expect(await reachable(takeOver)).toBe(true);
        } finally {
          await page.close();
        }
      }, 90_000);

      test(`for a password, on a phone: the masked box opens in reach, and closing it is the way back, in ${engine}, ${theme}`, async () => {
        const page = await asking("secret", engine, theme, PHONE);
        try {
          // The masked box is drawn only in the Computer, so for it the Computer opens itself.
          const sheet = page.getByRole("dialog", { name: "Computer" });
          const box = sheet.getByLabel(`The Bot needs ${SECRET_LABEL}`);
          await box.waitFor({ timeout: 20_000 });
          await shoot(page, `computer-panel-secret-${engine}-${theme}-390`);
          expect(await reachable(box)).toBe(true);
          // Typed where it is, with a real keyboard.
          await box.click();
          await page.keyboard.type("hunter2");
          const send = sheet.getByRole("button", { name: "Send to the page" });
          expect(await send.isEnabled()).toBe(true);
          expect(await reachable(send)).toBe(true);

          await sheet.getByRole("button", { name: "Close" }).click();
          await page
            .locator('[data-slot="sheet-content"]')
            .waitFor({ state: "detached" });
          await shoot(
            page,
            `computer-panel-secret-closed-${engine}-${theme}-390`,
          );
          expect(
            await reachable(page.getByRole("textbox", { name: "Message" })),
          ).toBe(true);
          expect(await fits(page)).toBe(true);
        } finally {
          await page.close();
        }
      }, 90_000);

      test(`to take over, on a wide screen: the Computer opens itself beside the conversation, as before, in ${engine}, ${theme}`, async () => {
        const page = await asking("takeOver", engine, theme, WIDE);
        try {
          await card(page)
            .getByText("The Bot needs you.")
            .waitFor({ timeout: 20_000 });
          const pane = page.locator('[data-slot="detail-pane"]');
          await pane
            .getByRole("region", { name: "Computer sidebar" })
            .waitFor({ timeout: 10_000 });
          await shoot(page, `computer-panel-take-over-${engine}-${theme}-1440`);
          expect(await page.getByRole("dialog").count()).toBe(0);
          expect(
            await pane.evaluate(
              (element) => element.getBoundingClientRect().width,
            ),
          ).toBe(360);
          expect(
            await reachable(
              card(page).getByRole("button", { name: "Take control" }),
            ),
          ).toBe(true);
          expect(await fits(page)).toBe(true);
        } finally {
          await page.close();
        }
      }, 90_000);

      test(`for a password, on a wide screen: the Computer opens itself beside the conversation, as before, in ${engine}, ${theme}`, async () => {
        const page = await asking("secret", engine, theme, WIDE);
        try {
          const pane = page.locator('[data-slot="detail-pane"]');
          await pane
            .getByLabel(`The Bot needs ${SECRET_LABEL}`)
            .waitFor({ timeout: 20_000 });
          await shoot(page, `computer-panel-secret-${engine}-${theme}-1440`);
          expect(await page.getByRole("dialog").count()).toBe(0);
          expect(await maskedBox(page).count()).toBe(1);
          expect(
            await reachable(pane.getByLabel(`The Bot needs ${SECRET_LABEL}`)),
          ).toBe(true);
          expect(await fits(page)).toBe(true);
        } finally {
          await page.close();
        }
      }, 90_000);
    }
});
