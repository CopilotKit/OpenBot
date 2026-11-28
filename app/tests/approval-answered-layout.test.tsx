import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DECLINED_BY_PERSON } from "@openbot/shared/approval-outcomes";
import type { Browser, BrowserType, Page, Route } from "playwright-core";
import { compile } from "tailwindcss";
import { approvalInboxResponse, approvalWriteResponse } from "./approvals-api";

/**
 * An approval the person answered stays in the conversation, in a real browser, live and after a
 * reload.
 *
 * Found testing a Windows install: a Bot asked, the person answered Allow once or Deny, and the card
 * went from the conversation for good, even after a reload; only the Computer's Activity said what
 * they had answered. Here a Bot asks to invite somebody (an app's tool) and the person allows it
 * once; the conversation goes on and the Bot asks to place an order (a browser step) and the person
 * denies it. Each answer folds to one line, "Allowed once: ..." and "Denied: ...", the way a Bot's
 * work folds, and each line opens to the card as it was answered. In the app's stylesheet, light and
 * dark, at a laptop's width and a phone's: nothing scrolls sideways.
 *
 *   OPENBOT_APP_BROWSER=1 bun test app/tests/approval-answered-layout.test.tsx
 *
 * Chromium by default, as CI has it. OPENBOT_APP_ENGINES=chromium,webkit adds WebKit. With
 * OPENBOT_APP_SHOTS=<dir> each state is saved as answered-<state>-<engine>-<theme>-<width>.png.
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
const ORIGIN = "http://openbot.test";

async function bundle(): Promise<string> {
  const built = await Bun.build({
    entrypoints: [
      join(import.meta.dir, "approval-answered-layout.fixture.tsx"),
    ],
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

const INVITE_ID = "invite-1";
const CLICK_ID = "click-1";

/** What the server holds for one run of the story: the conversation so far and the approvals. */
type Server = {
  messages: unknown[];
  requests: Record<string, unknown>[];
};

const ASKED_INVITE = {
  id: "u1",
  role: "user",
  content: "Invite Sam to the spec review on Friday at 10.",
};
const INVITE_CALL = {
  id: "a1",
  role: "assistant",
  content: "",
  toolCalls: [
    {
      id: INVITE_ID,
      type: "function",
      function: {
        name: "mcp__arcade-GoogleCalendar__CreateEvent",
        arguments: JSON.stringify({
          summary: "Spec review",
          attendee_emails: ["sam@example.com"],
        }),
      },
    },
  ],
};
const INVITED = [
  { id: "t1", role: "tool", toolCallId: INVITE_ID, content: "Event created." },
  {
    id: "a2",
    role: "assistant",
    content: "Done. Sam is invited to the spec review on Friday at 10.",
  },
];
const ASKED_ORDER = [
  {
    id: "u2",
    role: "user",
    content: "Now place the order in my cart on shop.example.",
  },
  {
    id: "a3",
    role: "assistant",
    content: "",
    toolCalls: [
      {
        id: "nav-1",
        type: "function",
        function: {
          name: "computer_navigate",
          arguments: JSON.stringify({ url: "https://shop.example/cart" }),
        },
      },
    ],
  },
  {
    id: "t3",
    role: "tool",
    toolCallId: "nav-1",
    content: JSON.stringify({
      ok: true,
      url: "https://shop.example/cart",
      title: "Your cart",
    }),
  },
  {
    id: "a4",
    role: "assistant",
    content: "",
    toolCalls: [
      {
        id: CLICK_ID,
        type: "function",
        function: {
          name: "computer_click",
          arguments: JSON.stringify({ ref: "e12", element: "Place order" }),
        },
      },
    ],
  },
];
const DENIED = [
  {
    id: "t4",
    role: "tool",
    toolCallId: CLICK_ID,
    content: JSON.stringify({ ok: false, error: DECLINED_BY_PERSON }),
  },
  {
    id: "a5",
    role: "assistant",
    content: "I didn't place the order, because you declined.",
  },
];

function inviteRequest() {
  return {
    id: "approval-invite",
    status: "pending",
    createdAt: "2026-11-25T10:00:00.000Z",
    action: {
      botId: "general-assistant",
      toolRef: "arcade-GoogleCalendar/CreateEvent",
      effect: "write",
      scope: "arcade-GoogleCalendar",
      threadId: "thread-1",
      toolCallId: INVITE_ID,
      args: { summary: "Spec review", attendee_emails: ["sam@example.com"] },
      target: {},
      policy: {
        behaviour: "ask",
        source: "safety",
        reason: "Sending something to other people asks you first.",
        kind: "sending",
      },
    },
  };
}

function clickRequest() {
  return {
    id: "approval-click",
    status: "pending",
    createdAt: "2026-11-25T10:05:00.000Z",
    action: {
      botId: "general-assistant",
      toolRef: "computer_click",
      effect: "write",
      scope: "shop.example",
      threadId: "thread-1",
      toolCallId: CLICK_ID,
      args: { ref: "e12", element: "Place order" },
      target: {},
      policy: {
        behaviour: "ask",
        source: "safety",
        reason: "Paying for something asks you first.",
        kind: "payments",
      },
    },
  };
}

/** The server finished carrying the conversation on after each decision: completed, as it marks it. */
function carriedOn(server: Server) {
  server.requests = server.requests.map((request) =>
    request.decision ? { ...request, status: "completed" } : request,
  );
}

async function fulfil(route: Route, answer: Response) {
  return route.fulfill({
    status: answer.status,
    contentType: answer.headers.get("content-type") ?? "application/json",
    body: await answer.text(),
  });
}

const browsers = new Map<string, Browser>();
let script: string;

beforeAll(async () => {
  if (!asked) return;
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
});

type Window = { width: number; height: number };

async function open(
  engine: string,
  theme: "light" | "dark",
  window: Window,
  server: Server,
): Promise<Page> {
  const browser = browsers.get(engine);
  if (!browser) throw new Error(`no ${engine}`);
  const page = await browser.newPage({
    viewport: window,
    colorScheme: theme,
    reducedMotion: "reduce",
  });
  page.on("pageerror", (error) => console.error(error));
  const inter = join(packageDir("@fontsource-variable/inter"), "files");
  await page.route(`${ORIGIN}/**`, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/answered.js")
      return route.fulfill({ contentType: "text/javascript", body: script });
    if (path === "/conversation.json")
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(server.messages),
      });
    const font = join(inter, path.split("/").pop() ?? "");
    if (path.startsWith("/files/") && existsSync(font))
      return route.fulfill({ path: font });
    if (path.startsWith("/api/")) {
      const body = request.postData() ?? undefined;
      const wrote = approvalWriteResponse(
        path,
        { method: request.method(), body },
        { requests: server.requests },
      );
      if (wrote) {
        // Decided: the person's answer is kept, and the action is the server's to carry on.
        const { decision } = JSON.parse(body ?? "{}") as { decision: string };
        const id = decodeURIComponent(path.split("/").at(-2) ?? "");
        server.requests = server.requests.map((one) =>
          one.id === id
            ? {
                ...one,
                status: decision === "deny" ? "denied" : "approved",
                decision,
                decidedAt: "2026-11-25T10:06:00.000Z",
              }
            : one,
        );
        return fulfil(route, wrote);
      }
      const read = approvalInboxResponse(path, {
        enabled: true,
        requests: server.requests,
      });
      if (read) return fulfil(route, read);
      return route.fulfill({ status: 404 });
    }
    return route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html lang="en" class="${theme}" style="color-scheme: ${theme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head><body><div id="root"></div><script type="module" src="/answered.js"></script></body></html>`,
    });
  });
  await page.goto(`${ORIGIN}/`);
  return page;
}

/** The app's stylesheet for what is on the page now, added again as new classes come in. */
async function styled(page: Page) {
  const classes = await page.evaluate(() =>
    [...document.querySelectorAll("[class]")].flatMap((element) => [
      ...element.classList,
    ]),
  );
  await page.addStyleTag({
    content: await stylesheet([...new Set(classes)]),
  });
  await page.evaluate(() => document.fonts.ready);
  // The rows' entrances taken to their end, so the picture is of the page at rest.
  await page.evaluate(() => {
    for (const animation of document.getAnimations())
      if (
        animation.effect?.getComputedTiming().iterations !==
        Number.POSITIVE_INFINITY
      )
        animation.finish();
  });
}

async function shoot(page: Page, name: string) {
  if (!shots) return;
  mkdirSync(shots, { recursive: true });
  await page.screenshot({ path: join(shots, `${name}.png`), fullPage: true });
}

/** The folded line an answer left, found by the words it starts with. */
const answerLine = (page: Page, said: string) =>
  page.locator("details.tool-line", {
    has: page.locator("summary", { hasText: `${said}:` }),
  });

async function answer(page: Page, choice: "Allow once" | "Deny") {
  const card = page.getByRole("region", { name: "Waiting for your approval" });
  await card.getByRole("radio", { name: choice }).check({ force: true });
  await card.getByRole("button", { name: choice }).click();
}

async function scrollsSideways(page: Page) {
  return page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
}

/** One line: the answer and what it was about, never wrapped. */
async function oneLine(page: Page, said: string) {
  const box = await answerLine(page, said).locator("summary").boundingBox();
  return (box?.height ?? 99) <= 28;
}

const WINDOWS: Window[] = [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
];

describe.skipIf(!asked)("an answered approval in a conversation", () => {
  for (const engine of engines)
    for (const theme of ["light", "dark"] as const)
      for (const window of WINDOWS) {
        const name = `${engine}-${theme}-${window.width}`;

        test(`stays as one line, live and after a reload, in ${engine}, ${theme}, ${window.width}px`, async () => {
          const server: Server = {
            messages: [ASKED_INVITE, INVITE_CALL],
            requests: [inviteRequest()],
          };
          let page = await open(engine, theme, window, server);
          try {
            // Asked: the card, waiting.
            const card = page.getByRole("region", {
              name: "Waiting for your approval",
            });
            await card.waitFor({ timeout: 15_000 });
            await styled(page);
            await shoot(page, `answered-1-asked-${name}`);

            // Allowed once, here: the card folds to its line, and the line stays.
            await answer(page, "Allow once");
            await answerLine(page, "Allowed once").waitFor({
              timeout: 15_000,
            });
            await card.waitFor({ state: "detached", timeout: 15_000 });
            await styled(page);
            await shoot(page, `answered-2-allowed-live-${name}`);
            expect(await oneLine(page, "Allowed once")).toBe(true);
            expect(
              await answerLine(page, "Allowed once")
                .locator("summary")
                .textContent(),
            ).toContain("Create event on Google Calendar");

            // The server carried it on, and the Bot asked again. Reloaded: the answer is still there.
            carriedOn(server);
            server.messages = [
              ASKED_INVITE,
              INVITE_CALL,
              ...INVITED,
              ...ASKED_ORDER,
            ];
            server.requests = [...server.requests, clickRequest()];
            await page.close();
            page = await open(engine, theme, window, server);
            await answerLine(page, "Allowed once").waitFor({
              timeout: 15_000,
            });
            await page
              .getByRole("region", { name: "Waiting for your approval" })
              .waitFor({ timeout: 15_000 });
            await styled(page);
            await shoot(page, `answered-3-reloaded-asked-again-${name}`);

            // Denied, here.
            await answer(page, "Deny");
            await answerLine(page, "Denied").waitFor({ timeout: 15_000 });
            await page
              .getByRole("region", { name: "Waiting for your approval" })
              .waitFor({ state: "detached", timeout: 15_000 });
            await styled(page);
            await shoot(page, `answered-4-denied-live-${name}`);

            // Reloaded once more, as a past conversation is opened: both answers, folded.
            carriedOn(server);
            server.messages = [...server.messages, ...DENIED];
            await page.close();
            page = await open(engine, theme, window, server);
            await answerLine(page, "Denied").waitFor({ timeout: 15_000 });
            await page.getByText("because you declined").waitFor();
            await styled(page);
            await shoot(page, `answered-5-reloaded-${name}`);
            for (const said of ["Allowed once", "Denied"]) {
              const line = answerLine(page, said);
              expect(await line.isVisible()).toBe(true);
              expect(
                await line.evaluate(
                  (element) => (element as HTMLDetailsElement).open,
                ),
              ).toBe(false);
              expect(await oneLine(page, said)).toBe(true);
            }
            expect(
              await answerLine(page, "Denied").locator("summary").textContent(),
            ).toContain("Click on shop.example");
            expect(
              await page
                .getByRole("region", { name: "Waiting for your approval" })
                .count(),
            ).toBe(0);
            expect(await scrollsSideways(page)).toBe(false);

            // Opened, a line is the card as it was answered, inside the column.
            await answerLine(page, "Denied").locator("summary").click();
            const opened = answerLine(page, "Denied").locator(
              '[data-slot="decision-card"]',
            );
            expect(await opened.isVisible()).toBe(true);
            expect(await opened.textContent()).toContain(
              "Paying for something asks you first.",
            );
            const box = await opened.boundingBox();
            expect((box?.x ?? -1) >= 0).toBe(true);
            expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(
              window.width + 0.5,
            );
            await styled(page);
            await shoot(page, `answered-6-opened-${name}`);
            expect(await scrollsSideways(page)).toBe(false);
          } finally {
            await page.close();
          }
        }, 120_000);
      }
});
