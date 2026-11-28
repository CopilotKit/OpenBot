import { afterAll, beforeAll, describe, expect } from "bun:test";
import type { Page, Request } from "playwright-core";
import {
  asked,
  engines,
  FakeServer,
  LOOKS,
  MOVING,
  NORTHWIND,
  open,
  shoot,
  start,
  stop,
  style,
  UNAVAILABLE,
} from "./organization-notices-browser";
import { test } from "./renderer-crash";

/**
 * While OpenBot moves an organization, or its database is briefly out of reach, the places the sweep
 * after #2151 found still treating it as a failure say the server's sentence calmly:
 *
 * - A conversation with a Bot, and the Bot's own chat page: a message sent during a move was refused
 *   by the runtime, 503 with the sentence and Retry-After. CopilotKit's client threw it as
 *   `REST run request failed: <body>`, status and headers gone, and the turn ended under a red
 *   warning, or in a red band on the Bot's page, saying "OpenBot couldn't reach its backend, so your
 *   message wasn't sent. Try again, or quit and reopen OpenBot."
 * - Admin's audit log: the filters' menus (Bot, Person, App, Tool, Rule) said "Loading…" for good
 *   when the read of what they offer was refused.
 *
 * And a real failure in each place is still said in red.
 *
 * In a real browser, Chromium and WebKit, at 1440 and 390 wide, light and dark, with the API and
 * the runtime answered at their own addresses:
 *
 *   OPENBOT_APP_BROWSER=1 OPENBOT_APP_ENGINES=chromium,webkit bun test app/tests/organization-unavailable-chat.test.tsx
 *
 * With OPENBOT_APP_SHOTS=<dir> each step is saved as organization-unavailable-chat-<step>-<engine>-<width>-<theme>.png.
 */
beforeAll(async () => {
  if (asked) await start("organization-unavailable-chat.fixture.tsx");
}, 120_000);

afterAll(async () => {
  await stop();
});

const BACKEND_UNREACHABLE =
  "OpenBot couldn't reach its backend, so your message wasn't sent. Try again, or quit and reopen OpenBot.";
const CHOICES_FAILED = "Couldn't load the choices. Try again in a moment.";

/** A problem in OpenBot's own shape (RFC 9457), as the server answers a hold or a fault. */
function problem(status: number, detail: string, code: string) {
  return {
    type: `https://open.bot/errors/${code.toLowerCase().replaceAll("_", "-")}`,
    title: status === 503 ? "Service unavailable." : "Unexpected server error.",
    status,
    detail,
    code,
    category: status === 503 ? "unavailable" : "internal",
    retryable: true,
    requestId: "req_test",
    traceId: "trace_test",
  };
}

/** The Bot whose conversation and page these are, as the API's Bot read gives it. */
const BOT = {
  id: "general-assistant",
  name: "General Assistant",
  title: "",
  roleDescription: "",
  avatarSeed: "General Assistant",
  lastConversationAt: null,
  mine: true,
  canManage: true,
  systemOwned: false,
  visibility: "private",
};

/**
 * The test's server, with the runtime (`/api/copilotkit`, through the backend as OpenBot runs it)
 * and the reads the conversation, the Bot's page and the audit log make beside the shared ones.
 */
class ChatServer extends FakeServer {
  /** How a run is refused while Northwind is reachable: a server fault, said in red. */
  runFails = false;
  /** How the audit log's filter choices are answered while Northwind is reachable. */
  choicesFail = false;

  private held(): boolean {
    return Date.now() < this.movingUntil;
  }

  override answer(request: Request) {
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    if (path.startsWith("/api/copilotkit")) return this.runtime(path);
    const scoped = path.match(/^\/api\/v2\/organizations\/([^/]+)(\/.*)$/);
    const rest = scoped?.[2] ?? "";
    if (scoped?.[1] === NORTHWIND.id && !this.held() && method === "GET") {
      if (rest === "/bots/general-assistant") return ok({ bot: BOT });
      if (/^\/conversations\/[^/]+\/voice-sessions$/.test(rest))
        return ok({ sessions: [], nextCursor: null });
      if (rest === "/audit-events/vocabulary")
        return this.choicesFail
          ? {
              status: 500,
              json: problem(
                500,
                "Unexpected server error.",
                "INTERNAL_SERVER_ERROR",
              ),
              contentType: "application/problem+json",
            }
          : ok({ bots: [], people: [], apps: [], tools: [], rules: [] });
      if (rest === "/audit-events")
        return ok({ auditEvents: [], nextCursor: null });
    }
    return super.answer(request);
  }

  /** The runtime, through Intelligence: a run asks for join credentials first. */
  private runtime(path: string) {
    if (path === "/api/copilotkit/info")
      return ok({
        version: "fixture",
        agents: {
          "general-assistant": { description: "Fixture", capabilities: {} },
        },
        mode: "intelligence",
        intelligence: { wsUrl: "ws://openbot.test/client" },
        telemetryDisabled: true,
      });
    // Joining a thread with nothing to replay.
    if (path.endsWith("/connect")) return { status: 204, json: undefined };
    if (/\/threads\/[^/]+\/messages$/.test(path))
      return ok({
        messages: [
          {
            id: "asked",
            role: "user",
            content: "What is 586 plus 637? Reply with the number only.",
          },
          { id: "answered", role: "assistant", content: "1223" },
        ],
      });
    if (path.endsWith("/run")) {
      // Every address of a held organization answers this, the runtime's included (app.ts onError).
      if (this.held())
        return {
          status: 503,
          json: problem(503, this.holdSaid, "SERVICE_UNAVAILABLE"),
          contentType: "application/problem+json",
          headers: { "Retry-After": String(this.retryAfterSeconds) },
        };
      if (this.runFails)
        return {
          status: 500,
          json: problem(
            500,
            "Unexpected server error.",
            "INTERNAL_SERVER_ERROR",
          ),
          contentType: "application/problem+json",
        };
    }
    return this.notFound();
  }
}

function ok(json: unknown) {
  return { status: 200, json };
}

/** Out of reach from now until the test ends: nothing is asked again before then. */
function hold(server: FakeServer, said: string) {
  server.holdSaid = said;
  server.retryAfterSeconds = 60;
  server.movingUntil = Number.POSITIVE_INFINITY;
}

/**
 * How `words` are drawn: in the destructive red or not, inside a box or band drawn in red or not,
 * and with a red icon beside them or not.
 *
 * The red is measured on a probe drawn `text-destructive`, which is put on the page and styled first:
 * the page is styled only for the classes it draws, and a calm page may draw none in red.
 */
async function drawn(page: Page, words: string) {
  await page.evaluate(() => {
    const probe = document.createElement("span");
    probe.className = "text-destructive";
    probe.hidden = true;
    document.body.append(probe);
  });
  await style(page);
  // The innermost element that says them, waited for: a menu can still be opening.
  const holder = page.getByText(words, { exact: true }).first();
  if (
    !(await holder.waitFor({ timeout: 5_000 }).then(
      () => true,
      () => false,
    ))
  )
    return null;
  return holder.evaluate((holder) => {
    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    const rgba = (color: string): [number, number, number, number] => {
      if (!context) return [0, 0, 0, 0];
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = "#000";
      context.fillStyle = color;
      context.fillRect(0, 0, 1, 1);
      const [r = 0, g = 0, b = 0, a = 0] = context.getImageData(
        0,
        0,
        1,
        1,
      ).data;
      return [r, g, b, a];
    };
    const probe = document.createElement("span");
    probe.className = "text-destructive";
    document.body.append(probe);
    const destructive = rgba(getComputedStyle(probe).color);
    probe.remove();
    const red = (color: string) => {
      const [r, g, b, a] = rgba(color);
      return (
        a > 0 &&
        Math.abs(r - destructive[0]) < 30 &&
        Math.abs(g - destructive[1]) < 30 &&
        Math.abs(b - destructive[2]) < 30
      );
    };
    let boxedInRed = false;
    let redIcon = false;
    for (
      let at: Element | null = holder, depth = 0;
      at && depth < 5;
      at = at.parentElement, depth++
    ) {
      const around = getComputedStyle(at);
      if (
        red(around.backgroundColor) ||
        (around.borderTopStyle !== "none" &&
          Number.parseFloat(around.borderTopWidth) > 0 &&
          red(around.borderTopColor))
      ) {
        boxedInRed = true;
      }
      for (const icon of at.querySelectorAll("svg"))
        if (red(getComputedStyle(icon).color)) redIcon = true;
    }
    return {
      red: red(getComputedStyle(holder).color),
      boxedInRed,
      redIcon,
    };
  });
}

/**
 * Type a message and send it, with a real keyboard: in a conversation's box with its Send button,
 * or in the Bot page's chat with Enter.
 */
async function send(page: Page, where: "conversation" | "bot", words: string) {
  const input =
    where === "conversation"
      ? page.getByRole("textbox", { name: "Message" })
      : page.locator("textarea").first();
  await input.click();
  await page.keyboard.type(words);
  if (where === "conversation")
    await page.getByRole("button", { name: "Send message" }).click();
  else await page.keyboard.press("Enter");
}

/**
 * The audit log's Add filter, opened on the Bot filter's choices, then what they say in their place
 * once it is `words`, waited for as the menu draws it.
 *
 * The page is styled only for the classes it draws (`style`), so a menu that has just opened is
 * drawn unstyled until it is styled again. Styled after Bot was pressed, the Add filter menu moved
 * and shrank under the pointer, the browser told the menu the pointer had left, and Bot's choices
 * closed, as they do when a person moves off them. The test then read them while they faded out,
 * and failed whenever the machine was slower than the fade. So the menu is styled as soon as it
 * opens, and Bot is pressed where the app draws it.
 *
 * A press opens Bot's choices at once; a hover first opens them after a delay, and the press could
 * close them.
 */
async function openBotChoices(page: Page, words: string) {
  await page.getByRole("button", { name: "Add filter" }).click();
  const bot = page.getByRole("menuitem", { name: "Bot", exact: true });
  await bot.waitFor({ timeout: 8_000 });
  await style(page);
  await bot.click();
  const said = page
    .locator("[data-slot=dropdown-menu-label]")
    .filter({ hasText: words });
  await said.waitFor({ timeout: 15_000 });
  return said;
}

/**
 * Whether Bot's choices are still open, after the page has been styled for them and measured: they
 * stay open until the pointer leaves them or a choice is made.
 */
async function botChoicesOpen(page: Page): Promise<boolean> {
  return (
    (await page
      .getByRole("menuitem", { name: "Bot", exact: true })
      .getAttribute("aria-expanded")) === "true"
  );
}

const CALM = { red: false, boxedInRed: false, redIcon: false };

describe.skipIf(!asked)(
  "the chat and the audit log's filters while the organization is moved or out of reach",
  () => {
    for (const engine of engines)
      for (const look of LOOKS)
        test(`each says the server's sentence calmly, in ${engine}, ${look.width}, ${look.theme}`, async () => {
          const seen: Record<string, unknown> = {};

          // A conversation: the message is sent as the move begins.
          {
            const server = new ChatServer();
            const page = await open(engine, look, server, "/conversation");
            try {
              await page.getByText("1223").waitFor({ timeout: 15_000 });
              hold(server, MOVING);
              await send(page, "conversation", "What is 110 plus 707?");
              const stopped = page.getByTestId("transcript-stopped");
              await stopped.waitFor({ timeout: 15_000 });
              await page.waitForTimeout(300);
              await shoot(
                page,
                "organization-unavailable-chat",
                "conversation",
                engine,
                look,
              );
              seen.conversation = {
                says: (await stopped.innerText()).trim(),
                drawn: await drawn(page, MOVING),
                backendUnreachable: await page
                  .getByText(/couldn't reach its backend/)
                  .count(),
              };
            } finally {
              await page.close();
            }
          }

          // The Bot's own chat page, its database out of reach.
          {
            const server = new ChatServer();
            const page = await open(
              engine,
              look,
              server,
              "/bot?agent=general-assistant",
            );
            try {
              await page
                .getByRole("heading", { name: "General Assistant" })
                .waitFor({ timeout: 15_000 });
              await page.waitForTimeout(500);
              hold(server, UNAVAILABLE);
              await send(page, "bot", "What is 110 plus 707?");
              const band = page.getByTestId("bot-chat-stopped");
              await band.waitFor({ timeout: 15_000 });
              await page.waitForTimeout(300);
              await shoot(
                page,
                "organization-unavailable-chat",
                "bot-page",
                engine,
                look,
              );
              seen.botPage = {
                says: (await band.innerText()).trim(),
                drawn: await drawn(page, UNAVAILABLE),
                backendUnreachable: await page
                  .getByText(/couldn't reach its backend/)
                  .count(),
              };
            } finally {
              await page.close();
            }
          }

          // Admin's audit log: the move begins after the log is open, before a filter's menu is.
          {
            const server = new ChatServer();
            const page = await open(engine, look, server, "/admin/audit");
            try {
              await page
                .getByRole("button", { name: "Add filter" })
                .waitFor({ timeout: 15_000 });
              hold(server, MOVING);
              const said = await openBotChoices(page, MOVING);
              await shoot(
                page,
                "organization-unavailable-chat",
                "audit-filters",
                engine,
                look,
              );
              seen.auditFilters = {
                says: (await said.innerText({ timeout: 5_000 })).trim(),
                drawn: await drawn(page, MOVING),
                open: await botChoicesOpen(page),
              };
            } finally {
              await page.close();
            }
          }

          expect(seen).toEqual({
            conversation: { says: MOVING, drawn: CALM, backendUnreachable: 0 },
            botPage: { says: UNAVAILABLE, drawn: CALM, backendUnreachable: 0 },
            auditFilters: { says: MOVING, drawn: CALM, open: true },
          });
        }, 180_000);

    for (const engine of engines)
      test(`a real failure is still said in red, in ${engine}`, async () => {
        const look = LOOKS[0];
        const seen: Record<string, unknown> = {};

        {
          const server = new ChatServer();
          server.runFails = true;
          const page = await open(engine, look, server, "/conversation");
          try {
            await page.getByText("1223").waitFor({ timeout: 15_000 });
            await send(page, "conversation", "What is 110 plus 707?");
            await page
              .getByTestId("transcript-stopped")
              .waitFor({ timeout: 15_000 });
            await style(page);
            seen.conversation = await drawn(page, BACKEND_UNREACHABLE);
          } finally {
            await page.close();
          }
        }

        {
          const server = new ChatServer();
          server.runFails = true;
          const page = await open(
            engine,
            look,
            server,
            "/bot?agent=general-assistant",
          );
          try {
            await page
              .getByRole("heading", { name: "General Assistant" })
              .waitFor({ timeout: 15_000 });
            await page.waitForTimeout(500);
            await send(page, "bot", "What is 110 plus 707?");
            await page
              .getByTestId("bot-chat-stopped")
              .waitFor({ timeout: 15_000 });
            await style(page);
            seen.botPage = await drawn(page, BACKEND_UNREACHABLE);
          } finally {
            await page.close();
          }
        }

        {
          const server = new ChatServer();
          server.choicesFail = true;
          const page = await open(engine, look, server, "/admin/audit");
          try {
            await page
              .getByRole("button", { name: "Add filter" })
              .waitFor({ timeout: 15_000 });
            await openBotChoices(page, CHOICES_FAILED);
            await shoot(
              page,
              "organization-unavailable-chat",
              "audit-filters-failed",
              engine,
              look,
            );
            seen.auditFilters = {
              ...(await drawn(page, CHOICES_FAILED)),
              open: await botChoicesOpen(page),
            };
          } finally {
            await page.close();
          }
        }

        expect(seen).toEqual({
          conversation: { red: false, boxedInRed: false, redIcon: true },
          botPage: { red: true, boxedInRed: true, redIcon: false },
          auditFilters: {
            red: true,
            boxedInRed: false,
            redIcon: false,
            open: true,
          },
        });
      }, 120_000);
  },
);

/**
 * The sentence is about now. Found by the end-to-end test of database sharding: from home it stayed
 * under the message box 30 seconds after the move had ended, and in a conversation the turn's card
 * stayed too. It goes once the organization answers again (lib/held-ends.ts), and the words sent stay
 * in the box to send again. The Bots panel said it under every Bot; it says it once.
 */
describe.skipIf(!asked)(
  "once the organization answers again after a move",
  () => {
    /** Northwind held until `release()`, telling a client to ask again in 2 seconds. */
    function holdBriefly(server: FakeServer) {
      hold(server, MOVING);
      server.retryAfterSeconds = 2;
      return () => {
        server.movingUntil = 0;
      };
    }

    /** How many places on the page say `words`, each the innermost element that does. */
    async function times(page: Page, words: string): Promise<number> {
      return page.evaluate((said) => {
        const holders = [...document.querySelectorAll("body *")].filter(
          (element) =>
            element.checkVisibility() && element.textContent?.trim() === said,
        );
        return holders.filter(
          (element) =>
            !holders.some(
              (other) => other !== element && element.contains(other),
            ),
        ).length;
      }, words);
    }

    for (const engine of engines)
      for (const look of LOOKS)
        test(`a conversation, a Bot's page and home say it while it lasts, keep the message and clear after it, and the Bots panel says it once, in ${engine}, ${look.width}, ${look.theme}`, async () => {
          const seen: Record<string, unknown> = {};
          const message = "Name a planet with rings.";

          // A conversation.
          {
            const server = new ChatServer();
            const page = await open(engine, look, server, "/conversation");
            try {
              await page.getByText("1223").waitFor({ timeout: 15_000 });
              const release = holdBriefly(server);
              await send(page, "conversation", message);
              const stopped = page.getByTestId("transcript-stopped");
              await stopped.waitFor({ timeout: 15_000 });
              const during = {
                says: (await stopped.innerText()).trim(),
                drawn: await drawn(page, MOVING),
                kept: (
                  await page
                    .getByRole("textbox", { name: "Message" })
                    .innerText()
                ).trim(),
              };
              await shoot(
                page,
                "organization-unavailable-chat",
                "conversation-held",
                engine,
                look,
              );
              release();
              const cleared = await stopped
                .waitFor({ state: "detached", timeout: 12_000 })
                .then(
                  () => true,
                  () => false,
                );
              await shoot(
                page,
                "organization-unavailable-chat",
                "conversation-back",
                engine,
                look,
              );
              seen.conversation = { ...during, cleared };
            } finally {
              await page.close();
            }
          }

          // The Bot's own chat page.
          {
            const server = new ChatServer();
            const page = await open(
              engine,
              look,
              server,
              "/bot?agent=general-assistant",
            );
            try {
              await page
                .getByRole("heading", { name: "General Assistant" })
                .waitFor({ timeout: 15_000 });
              await page.waitForTimeout(500);
              const release = holdBriefly(server);
              await send(page, "bot", message);
              const band = page.getByTestId("bot-chat-stopped");
              await band.waitFor({ timeout: 15_000 });
              const says = (await band.innerText()).trim();
              release();
              const cleared = await band
                .waitFor({ state: "detached", timeout: 12_000 })
                .then(
                  () => true,
                  () => false,
                );
              seen.botPage = { says, cleared };
            } finally {
              await page.close();
            }
          }

          // Home: the message is sent as the move begins, and home takes it back.
          {
            const server = new ChatServer();
            const page = await open(engine, look, server, "/");
            try {
              const box = page.getByRole("textbox", { name: "Message" });
              await box.waitFor({ timeout: 15_000 });
              await page.waitForTimeout(500);
              const release = holdBriefly(server);
              await box.click();
              await page.keyboard.type(message);
              await page.keyboard.press("Enter");
              const said = page.getByText(MOVING, { exact: true });
              await said.waitFor({ timeout: 15_000 });
              const during = {
                says: await times(page, MOVING),
                drawn: await drawn(page, MOVING),
                kept: (await box.innerText()).trim(),
              };
              await shoot(
                page,
                "organization-unavailable-chat",
                "home-held",
                engine,
                look,
              );
              release();
              const cleared = await said
                .waitFor({ state: "detached", timeout: 12_000 })
                .then(
                  () => true,
                  () => false,
                );
              await shoot(
                page,
                "organization-unavailable-chat",
                "home-back",
                engine,
                look,
              );
              seen.home = {
                ...during,
                cleared,
                keptAfter: (await box.innerText()).trim(),
              };
            } finally {
              await page.close();
            }
          }

          // The Bots panel, opened while the move goes on: three Bots, each with its conversations.
          {
            const server = new ChatServer();
            hold(server, MOVING);
            const page = await open(engine, look, server, "/bots-panel");
            try {
              await page.getByText("Risk Analyst").waitFor({ timeout: 15_000 });
              await page
                .getByText(MOVING, { exact: true })
                .first()
                .waitFor({ timeout: 15_000 });
              await page.waitForTimeout(500);
              await shoot(
                page,
                "organization-unavailable-chat",
                "bots-panel",
                engine,
                look,
              );
              seen.botsPanel = {
                says: await times(page, MOVING),
                drawn: await drawn(page, MOVING),
              };
            } finally {
              await page.close();
            }
          }

          expect(seen).toEqual({
            conversation: {
              says: MOVING,
              drawn: CALM,
              kept: message,
              cleared: true,
            },
            botPage: { says: MOVING, cleared: true },
            home: {
              says: 1,
              drawn: CALM,
              kept: message,
              cleared: true,
              keptAfter: message,
            },
            botsPanel: { says: 1, drawn: CALM },
          });
        }, 240_000);
  },
);
