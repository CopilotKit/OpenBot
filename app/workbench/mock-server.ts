/*
 * MOCK SERVER, FOR TESTS ONLY. Never part of OpenBot: nothing in app/src imports it, and nothing
 * starts it but these commands. It stands in for OpenBot's server so the REAL built app can run
 * signed in on a machine with no server and no Docker (the phone app's UI tests, screenshots).
 *
 *   # The app, served as an install serves it, passing /api here:
 *   cd app && bun run build
 *   APP_PORT=3010 SERVER_PORT=3001 bun app/serve.ts
 *
 *   # Signed in (everybody is, cookie or not):
 *   bun app/workbench/mock-server.ts
 *
 *   # Signed out: only a browser holding the mock's session cookie is signed in, as after
 *   # /api/auth/shell/enter. Everybody else is answered 401, like the workbench's app-signed-out scene.
 *   MOCK_SIGNED_OUT=1 bun app/workbench/mock-server.ts
 *
 *   # As a server without the phone app's sign-in hand-off: every /api/auth/shell/* answers 404.
 *   MOCK_NO_HANDOFF=1 MOCK_SIGNED_OUT=1 bun app/workbench/mock-server.ts
 *
 *   # As a server from before /api/auth/shell/enter asked for the OpenBot-Shell header (below), for
 *   # phone app builds that don't send it yet:
 *   MOCK_ENTER_NO_HEADER_CHECK=1 bun app/workbench/mock-server.ts
 *
 *   # Another person in another organization (Sam Rivera in Acme when unset), say for a second mock
 *   # standing in for a self-hosted OpenBot:
 *   MOCK_PERSON_NAME="Robin Park" MOCK_ORG_NAME="Globex" SERVER_PORT=3002 bun app/workbench/mock-server.ts
 *
 * It listens on 127.0.0.1:${SERVER_PORT:-3001}. Besides the API it answers:
 *
 *   GET  /__mock/session                    {"signedIn": boolean}: whether a request with no cookie is
 *   POST /__mock/session {"signedIn": bool}   signed in, and to change it at run time.
 *   GET  /api/auth/shell/config?platform=ios
 *        What the phone app asks before signing in: {"handoff":true,"callback":"scheme",
 *        "callbackUrl":"openbotshell://signed-in"}. 404 under MOCK_NO_HANDOFF.
 *   GET  /api/auth/shell/handoff?challenge=C[&platform=ios][&auto=1]
 *        The page the phone app opens in its sign-in sheet. C is a PKCE S256 challenge (43
 *        characters of base64url). A page titled "Mock sign-in" with one link, #mock-sign-in, "Sign in
 *        as test person", to openbotshell://signed-in?ticket=T. T is single use and lasts 60 s.
 *        With auto=1 the page follows its link by itself after 800 ms. 400 without a valid C.
 *   GET  /api/auth/shell/enter?ticket=T&verifier=V&to=/path
 *        Loaded by the web view, which sends the header `OpenBot-Shell: ios` (or `android`). With that
 *        header, a Sec-Fetch-Site that is absent or `none`, a Sec-Fetch-Mode that is absent or
 *        `navigate`, and a known, unused, unexpired T whose C is base64url(sha256(V)): sets the
 *        cookie better-auth.session_token=mock, marks T used and answers 303 to `to` (an own path,
 *        else /). Otherwise 303 to /sign?native-sign-in=failed, setting nothing; a refusal for any of
 *        those headers is made before T is looked at, so it leaves T unused. MOCK_ENTER_NO_HEADER_CHECK=1 skips every
 *        header check, as the server did before it asked for them.
 *   POST /api/auth/sign-out
 *        Ends the mock's session: its cookie stops counting until the next /enter.
 *
 * Signed in, the API answers as the workbench's app-home scene does (workbench/session.ts,
 * api/extraHandlers.ts and the spec's generated answers), with a person (Sam Rivera, in Acme, unless
 * MOCK_PERSON_NAME and MOCK_ORG_NAME say otherwise),
 * three Bots (General Assistant, Research Bot, Writing Bot) and fifteen conversations, the first three
 * Competitor pricing notes (pinned and unread), Quarterly forecast and Trip to Lisbon, then one a Bot
 * is working in (Board update for December), another unread (Launch announcement) and more, eight of
 * them General Assistant's, each with a short transcript. A
 * conversation made while it runs (sending from Home) is kept in memory until it stops: its own GET
 * answers it, the list shows it, its runs answer it and its messages read back. The live socket the
 * app opens is accepted and kept quiet.
 */

import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";
import type { ServerWebSocket } from "bun";
import { HttpResponse, http, type RequestHandler } from "msw";
import type { ApiRoute } from "../../desktop/workbench/appContract";
import type { Bot, ConversationSummary } from "../src/lib/api/generated/model";
import { extraHandlers } from "./api/extraHandlers";
import { installFakeApi } from "./api/fakeApi";
import { pickAggregators } from "./api/handlers";
import { DEFAULT_SESSION, sessionApi } from "./session";

const PORT = Number(process.env.SERVER_PORT ?? 3001);
const ORIGIN = `http://127.0.0.1:${PORT}`;
/**
 * The signed-in person and their organization: Sam Rivera in Acme, or the names in MOCK_PERSON_NAME
 * and MOCK_ORG_NAME, so a second mock beside the first (a self-hosted OpenBot in a sign-in test) can
 * show which server a screen is on. The app draws the initials from the name.
 */
const SESSION: typeof DEFAULT_SESSION = DEFAULT_SESSION.signedIn
  ? {
      ...DEFAULT_SESSION,
      name: process.env.MOCK_PERSON_NAME?.trim() || DEFAULT_SESSION.name,
      organization: {
        ...DEFAULT_SESSION.organization,
        name:
          process.env.MOCK_ORG_NAME?.trim() ||
          DEFAULT_SESSION.organization.name,
      },
    }
  : DEFAULT_SESSION;
const ORGANIZATION = SESSION.signedIn ? SESSION.organization.id : "default";
const API = `*/api/v2/organizations/:organizationId`;
/** The cookie that makes a request signed in, whatever the session's default. */
export const MOCK_SESSION_COOKIE = "better-auth.session_token";
const MOCK_SESSION_VALUE = "mock";
const HANDOFF = process.env.MOCK_NO_HANDOFF !== "1";
/** Whether /api/auth/shell/enter asks for the phone app's header, as OpenBot's server does. */
const ENTER_HEADER_CHECK = process.env.MOCK_ENTER_NO_HEADER_CHECK !== "1";
/** The header the phone app's web view sends on /api/auth/shell/enter, and what it may say. */
const SHELL_HEADER = "OpenBot-Shell";
const SHELL_PLATFORMS = new Set(["ios", "android"]);
// MOCK_REPLY=1: a run answers with one canned sentence (the iOS shell's video). Off by default.
const REPLY = process.env.MOCK_REPLY === "1";
const TICKET_MS = 60_000;

/** Whether a request with no mock cookie is signed in. */
let signedInByDefault = process.env.MOCK_SIGNED_OUT !== "1";
/** The mock's one session was signed out: its cookie no longer counts until the next sign-in. */
let mockSessionEnded = false;

// The Bots and conversations every signed-in page shows. ---------------------------------------

const GENERAL_BOT: Bot = {
  id: "general-assistant",
  name: "General Assistant",
  title: "Everyday Work",
  roleDescription:
    "Help with everyday work using clear, concise, and accurate answers.",
  avatarSeed: "general-assistant",
  visibility: "public",
  hidden: false,
  pinned: false,
  systemOwned: true,
  endpoint: null,
  hasAuth: false,
  hasCallbackToken: false,
  isolated: false,
  framework: "OpenBot",
  canManage: false,
  mine: false,
  assignedToMe: false,
  builtIn: false,
  runsOnOpenBotModel: true,
  keyFromOpenBot: false,
  isolationActive: false,
  isolationOffReason: null,
};

const RESEARCH_BOT: Bot = {
  ...GENERAL_BOT,
  id: "research-bot",
  name: "Research Bot",
  title: "Market Research",
  roleDescription: "Find, compare and summarize what competitors publish.",
  avatarSeed: "research-bot",
  visibility: "private",
  systemOwned: false,
  canManage: true,
  mine: true,
};

const WRITING_BOT: Bot = {
  ...GENERAL_BOT,
  id: "writing-bot",
  name: "Writing Bot",
  title: "Writing",
  roleDescription: "Drafts, edits and tightens what you write.",
  avatarSeed: "writing-bot",
  visibility: "private",
  systemOwned: false,
  canManage: true,
  mine: true,
};

export const MOCK_BOTS: readonly Bot[] = [
  GENERAL_BOT,
  RESEARCH_BOT,
  WRITING_BOT,
];

function conversation(
  fields: Partial<ConversationSummary> &
    Pick<ConversationSummary, "id" | "botIds" | "summary">,
): ConversationSummary {
  const bot = MOCK_BOTS.find((one) => one.id === fields.botIds[0]);
  return {
    name: bot?.name ?? "Bot",
    threadId: `thread-${fields.id}`,
    active: true,
    lastMessageAt: "2026-11-26T09:30:00.000Z",
    opening: null,
    lastMessage: null,
    lastMessageBotId: fields.botIds[0] ?? null,
    createdAt: "2026-11-20T09:00:00.000Z",
    pinned: false,
    lastReadAt: "2026-11-26T09:31:00.000Z",
    canRename: true,
    task: false,
    work: [],
    ...fields,
  };
}

/** Newest first, as the server orders them (pinned first is the page's and the sidebar's). */
export const MOCK_CONVERSATIONS: readonly ConversationSummary[] = [
  conversation({
    id: "c-pricing",
    botIds: [RESEARCH_BOT.id],
    summary: "Competitor pricing notes",
    opening: "What do our three closest competitors charge?",
    lastMessage: "All three moved to per-seat pricing this year.",
    lastMessageAt: "2026-11-27T08:15:00.000Z",
    // Pinned, and unread: the Bot answered after it was last opened.
    pinned: true,
    lastReadAt: "2026-11-27T08:00:00.000Z",
  }),
  conversation({
    id: "c-forecast",
    botIds: [GENERAL_BOT.id],
    summary: "Quarterly forecast",
    opening: "Can you draft the quarterly forecast?",
    lastMessage: "Here is the first draft.",
    lastMessageAt: "2026-11-26T16:40:00.000Z",
    lastReadAt: "2026-11-26T16:41:00.000Z",
  }),
  conversation({
    id: "c-lisbon",
    botIds: [GENERAL_BOT.id],
    summary: "Trip to Lisbon",
    opening: "Plan three days in Lisbon in March.",
    lastMessage: "Day one starts in Alfama.",
    lastMessageAt: "2026-11-24T11:05:00.000Z",
    lastReadAt: "2026-11-24T11:06:00.000Z",
  }),
  /*
   * Enough more for the panels' states: a conversation a Bot is working in, another unread, a
   * third Bot, and more under General Assistant than the Bots panel shows before Show more
   * (`BOT_CONVERSATIONS_PAGE`, 5), and a list long enough to scroll.
   */
  conversation({
    id: "c-board",
    botIds: [GENERAL_BOT.id],
    summary: "Board update for December",
    opening: "Draft the December board update from last month's numbers.",
    lastMessage: "Pulling the revenue figures now.",
    lastMessageAt: "2026-11-24T10:20:00.000Z",
    lastReadAt: "2026-11-24T10:21:00.000Z",
    busy: true,
  }),
  conversation({
    id: "c-launch-post",
    botIds: [WRITING_BOT.id],
    summary: "Launch announcement",
    opening: "Tighten the launch post to 200 words.",
    lastMessage: "Here is a 196-word version.",
    lastMessageAt: "2026-11-23T15:00:00.000Z",
    // Unread: the Bot answered after it was last opened.
    lastReadAt: "2026-11-23T14:00:00.000Z",
  }),
  conversation({
    id: "c-hiring",
    botIds: [GENERAL_BOT.id],
    summary: "Hiring plan",
    opening: "Outline a hiring plan for two engineers.",
    lastMessage: "Two roles, staggered by a month.",
    lastMessageAt: "2026-11-22T09:10:00.000Z",
    lastReadAt: "2026-11-22T09:11:00.000Z",
  }),
  conversation({
    id: "c-churn",
    botIds: [RESEARCH_BOT.id],
    summary: "Why customers churn",
    opening: "What do churned customers say in their exit surveys?",
    lastMessage: "Price comes up in a third of them.",
    lastMessageAt: "2026-11-21T13:30:00.000Z",
    lastReadAt: "2026-11-21T13:31:00.000Z",
  }),
  conversation({
    id: "c-offsite",
    botIds: [GENERAL_BOT.id],
    summary: "Team offsite agenda",
    opening: "Plan a two-day offsite agenda.",
    lastMessage: "Day two is workshops only.",
    lastMessageAt: "2026-11-20T16:45:00.000Z",
    lastReadAt: "2026-11-20T16:46:00.000Z",
  }),
  conversation({
    id: "c-newsletter",
    botIds: [WRITING_BOT.id],
    summary: "November newsletter",
    opening: "Write the November customer newsletter.",
    lastMessage: "Three stories and a product tip.",
    lastMessageAt: "2026-11-19T10:00:00.000Z",
    lastReadAt: "2026-11-19T10:01:00.000Z",
  }),
  conversation({
    id: "c-expenses",
    botIds: [GENERAL_BOT.id],
    summary: "Expense policy questions",
    opening: "Can I expense a co-working day pass?",
    lastMessage: "Yes, up to twice a month.",
    lastMessageAt: "2026-11-18T12:20:00.000Z",
    lastReadAt: "2026-11-18T12:21:00.000Z",
  }),
  conversation({
    id: "c-pitch",
    botIds: [RESEARCH_BOT.id],
    summary: "Market size for the pitch",
    opening: "How big is the market for our pitch deck?",
    lastMessage: "About 4 billion dollars a year.",
    lastMessageAt: "2026-11-17T08:40:00.000Z",
    lastReadAt: "2026-11-17T08:41:00.000Z",
  }),
  conversation({
    id: "c-roadmap",
    botIds: [GENERAL_BOT.id],
    summary: "Q1 roadmap",
    opening: "Turn these notes into a Q1 roadmap.",
    lastMessage: "Three themes, nine items.",
    lastMessageAt: "2026-11-15T14:00:00.000Z",
    lastReadAt: "2026-11-15T14:01:00.000Z",
  }),
  conversation({
    id: "c-style",
    botIds: [WRITING_BOT.id],
    summary: "House style guide",
    opening: "Make a one-page style guide for our blog.",
    lastMessage: "Short sentences, no jargon, one idea per paragraph.",
    lastMessageAt: "2026-11-13T11:15:00.000Z",
    lastReadAt: "2026-11-13T11:16:00.000Z",
  }),
  conversation({
    id: "c-vendors",
    botIds: [GENERAL_BOT.id],
    summary: "Compare payroll vendors",
    opening: "Compare three payroll vendors for a team of 20.",
    lastMessage: "The middle one is cheapest at our size.",
    lastMessageAt: "2026-11-11T09:30:00.000Z",
    lastReadAt: "2026-11-11T09:31:00.000Z",
  }),
  conversation({
    id: "c-retro",
    botIds: [GENERAL_BOT.id],
    summary: "Sprint retro notes",
    opening: "Summarize the sprint retro.",
    lastMessage: "Two things to keep, one to change.",
    lastMessageAt: "2026-11-09T17:00:00.000Z",
    lastReadAt: "2026-11-09T17:01:00.000Z",
  }),
];

/**
 * The conversations made while the mock runs (`POST /conversations`, as sending from Home does),
 * newest first. Kept in memory for the life of the process and answered like the fixed ones above:
 * by their own GET, in the list, and with their messages read back.
 */
const created: ConversationSummary[] = [];

/** What a made conversation's runs said, by thread: the person's messages and the replies. */
const said = new Map<string, { id: string; role: string; content: string }[]>();

/** Every conversation the mock knows, newest first: the ones made here, then the fixed ones. */
function allConversations(): ConversationSummary[] {
  return [...created, ...MOCK_CONVERSATIONS];
}

function findConversation(id: string): ConversationSummary | undefined {
  return allConversations().find((one) => one.id === id);
}

/** Each conversation's transcript: what the person asked, and the Bot's answer. */
function transcript(id: string) {
  const found = findConversation(id);
  if (!found) return [];
  const kept = said.get(found.threadId);
  if (kept) return kept;
  return [
    { id: `${id}-1`, role: "user", content: found.opening ?? "Hello" },
    {
      id: `${id}-2`,
      role: "assistant",
      content: found.lastMessage ?? "Hello!",
    },
  ];
}

function byThread(threadId: string): ConversationSummary | undefined {
  return allConversations().find((one) => one.threadId === threadId);
}

/** One AG-UI stream that replays a transcript and ends. */
function replay(threadId: string): Response {
  const events = [
    { type: "RUN_STARTED", threadId, runId: "mock-join" },
    {
      type: "MESSAGES_SNAPSHOT",
      messages: transcript(byThread(threadId)?.id ?? ""),
    },
    { type: "RUN_FINISHED", threadId, runId: "mock-join" },
  ];
  return new Response(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
    {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      },
    },
  );
}

/** The answers that make the pages above real-looking. Ahead of the spec's generated ones. */
function mockDataHandlers(): RequestHandler[] {
  return [
    http.get(`${API}/bots`, ({ request }) => {
      const hidden = new URL(request.url).searchParams.get("hidden");
      return HttpResponse.json({
        bots: hidden === "true" ? [] : MOCK_BOTS,
        nextCursor: null,
      });
    }),
    http.get(`${API}/bots/:botId`, ({ params }) => {
      const bot = MOCK_BOTS.find((one) => one.id === params.botId);
      return bot
        ? HttpResponse.json({ bot })
        : HttpResponse.json(
            { detail: "There is no such Bot." },
            { status: 404 },
          );
    }),
    http.get(`${API}/conversations`, ({ request }) => {
      const url = new URL(request.url);
      const q = url.searchParams.get("q")?.toLowerCase();
      const botId = url.searchParams.get("botId");
      const matching = allConversations().filter(
        (one) =>
          (!botId || one.botIds.includes(botId)) &&
          (!q ||
            [one.name, one.summary, one.opening, one.lastMessage].some(
              (field) => field?.toLowerCase().includes(q),
            )),
      );
      // Paged only where a page size is asked for (the Bots panel's 5 a Bot): the cursor is an offset.
      const limit = Number(url.searchParams.get("limit"));
      if (!Number.isInteger(limit) || limit <= 0)
        return HttpResponse.json({ conversations: matching, nextCursor: null });
      const from = Number(url.searchParams.get("cursor") ?? 0) || 0;
      const conversations = matching.slice(from, from + limit);
      return HttpResponse.json({
        conversations,
        nextCursor:
          from + limit < matching.length ? String(from + limit) : null,
      });
    }),
    // A conversation made here, kept until the mock stops: its own GET, the list and its runs know it.
    http.post(`${API}/conversations`, async ({ request }) => {
      const body = (await request.json().catch(() => ({}))) as {
        botIds?: unknown;
      };
      const botIds = Array.isArray(body.botIds)
        ? body.botIds.filter((one): one is string => typeof one === "string")
        : [];
      const now = new Date().toISOString();
      const made = conversation({
        id: crypto.randomUUID(),
        botIds: botIds.length ? botIds : [GENERAL_BOT.id],
        summary: null,
        lastMessageAt: now,
        createdAt: now,
        lastReadAt: now,
      });
      created.unshift(made);
      const { id, name, threadId, active, lastMessageAt, work } = made;
      return HttpResponse.json(
        {
          conversation: {
            id,
            name,
            botIds: made.botIds,
            threadId,
            active,
            lastMessageAt,
            work,
          },
        },
        { status: 201 },
      );
    }),
    http.get(`${API}/conversations/:conversationId`, ({ params }) => {
      const found = findConversation(String(params.conversationId));
      if (!found)
        return HttpResponse.json(
          { detail: "There is no such conversation." },
          { status: 404 },
        );
      const { id, name, botIds, threadId, active, lastMessageAt, work } = found;
      return HttpResponse.json({
        conversation: {
          id,
          name,
          botIds,
          threadId,
          active,
          lastMessageAt,
          work,
        },
      });
    }),
    // Push is set up here, as on a server that offers it: the phone app's tests check that the
    // page still offers no browser notifications inside the native shell.
    http.get(`${API}/notification-transports`, () =>
      HttpResponse.json({
        notificationTransports: [{ id: "push", title: "Push notifications" }],
        nextCursor: null,
      }),
    ),
    http.get(`${API}/conversations/:conversationId/refused-turns`, () =>
      HttpResponse.json({ refusedTurns: [], nextCursor: null }),
    ),
    http.post(
      `${API}/conversations/:conversationId/read`,
      () => new HttpResponse(null, { status: 204 }),
    ),
    // The last thing said, as the page reports it: a made conversation's row shows it, and its
    // first message names it. The fixed ones keep the preview they were drawn with.
    http.post(
      `${API}/conversations/:conversationId/activity`,
      async ({ params, request }) => {
        const found = created.find((one) => one.id === params.conversationId);
        const body = (await request.json().catch(() => ({}))) as {
          text?: unknown;
          botId?: unknown;
          at?: unknown;
        };
        if (found && typeof body.text === "string" && body.text.trim()) {
          found.opening ??= body.text;
          found.summary ??= body.text;
          found.lastMessage = body.text;
          found.lastMessageBotId =
            typeof body.botId === "string" ? body.botId : null;
          found.lastMessageAt =
            typeof body.at === "string" ? body.at : new Date().toISOString();
          found.lastReadAt = found.lastMessageAt;
        }
        return new HttpResponse(null, { status: 204 });
      },
    ),
    http.post(
      `${API}/conversations/:conversationId/signal-busy`,
      () => new HttpResponse(null, { status: 204 }),
    ),
    http.get(`${API}/conversations/:conversationId/voice-sessions`, () =>
      HttpResponse.json({ sessions: [], nextCursor: null }),
    ),
    http.get("*/api/copilotkit/threads/:threadId/messages", ({ params }) =>
      HttpResponse.json({
        messages: transcript(byThread(String(params.threadId))?.id ?? ""),
      }),
    ),
    http.post(
      "*/api/copilotkit/agent/:agentId/connect",
      async ({ request }) => {
        const body = (await request.json().catch(() => ({}))) as {
          threadId?: string;
        };
        return replay(body.threadId ?? "");
      },
    ),
    // A run the mock can't answer: it starts and finishes with nothing said.
    http.post("*/api/copilotkit/agent/:agentId/run", async ({ request }) => {
      const body = (await request.json().catch(() => ({}))) as {
        threadId?: string;
        runId?: string;
        messages?: { id?: unknown; role?: unknown; content?: unknown }[];
      };
      const threadId = body.threadId ?? "";
      const runId = body.runId ?? "mock-run";
      const reply =
        "Two of the three cut their entry price; one added a free tier.";
      // A made conversation keeps what its runs said, so its messages read back after a reload.
      if (created.some((one) => one.threadId === threadId)) {
        const messages = (Array.isArray(body.messages) ? body.messages : [])
          .filter(
            (one) =>
              (one.role === "user" || one.role === "assistant") &&
              typeof one.content === "string",
          )
          .map((one, index) => ({
            id: typeof one.id === "string" ? one.id : `${threadId}-${index}`,
            role: String(one.role),
            content: String(one.content),
          }));
        if (REPLY)
          messages.push({
            id: `${runId}-reply`,
            role: "assistant",
            content: reply,
          });
        said.set(threadId, messages);
      }
      return new Response(
        [
          { type: "RUN_STARTED", threadId, runId },
          ...(REPLY
            ? [
                {
                  type: "TEXT_MESSAGE_START",
                  messageId: `${runId}-reply`,
                  role: "assistant",
                },
                {
                  type: "TEXT_MESSAGE_CONTENT",
                  messageId: `${runId}-reply`,
                  delta: reply,
                },
                { type: "TEXT_MESSAGE_END", messageId: `${runId}-reply` },
              ]
            : []),
          { type: "RUN_FINISHED", threadId, runId },
        ]
          .map((event) => `data: ${JSON.stringify(event)}\n\n`)
          .join(""),
        { headers: { "content-type": "text/event-stream" } },
      );
    }),
  ];
}

// The spec's generated answers. The workbench reads them with Vite's import.meta.glob
// (api/handlers.ts); under plain bun the same files are found with Bun.Glob.

async function generatedHandlersFromDisk(): Promise<RequestHandler[]> {
  const root = join(import.meta.dir, "../src/lib/api/generated");
  const modules: Record<string, Record<string, unknown>> = {};
  for await (const path of new Bun.Glob("*/*.msw.ts").scan(root)) {
    modules[path] = (await import(join(root, path))) as Record<string, unknown>;
  }
  return pickAggregators(modules);
}

// Signed in or not, per request. ---------------------------------------------------------------

function hasMockCookie(request: Request): boolean {
  if (mockSessionEnded) return false;
  const cookies = request.headers.get("cookie") ?? "";
  return cookies
    .split(";")
    .some(
      (pair) => pair.trim() === `${MOCK_SESSION_COOKIE}=${MOCK_SESSION_VALUE}`,
    );
}

function signedIn(request: Request): boolean {
  return signedInByDefault || hasMockCookie(request);
}

/** What a signed-out request is refused at: the same two the app-signed-out scene refuses. */
const SIGNED_OUT_PATHS = [
  /^\/api\/v2\/organizations\/[^/]+\/people\/me$/,
  /^\/api\/v2\/people\/me\/organizations$/,
];

// The phone app's sign-in hand-off. ------------------------------------------------------------

type Ticket = { challenge: string; expires: number; used: boolean };
const tickets = new Map<string, Ticket>();

const CHALLENGE = /^[A-Za-z0-9_-]{43}$/;

function base64url(bytes: Buffer): string {
  return bytes
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** An own path: one slash, then anything but a second one. */
function ownPath(to: string | null): string {
  return to?.startsWith("/") && !to.startsWith("//") && !to.startsWith("/\\")
    ? to
    : "/";
}

function escapeHtml(text: string): string {
  return text.replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ] ?? char,
  );
}

function handoffPage(url: URL): Response {
  const challenge = url.searchParams.get("challenge") ?? "";
  if (!CHALLENGE.test(challenge))
    return new Response("A PKCE S256 challenge is required.", { status: 400 });
  const ticket = base64url(randomBytes(24));
  tickets.set(ticket, {
    challenge,
    expires: Date.now() + TICKET_MS,
    used: false,
  });
  const target = escapeHtml(`openbotshell://signed-in?ticket=${ticket}`);
  const auto = url.searchParams.get("auto") === "1";
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Mock sign-in</title>
${auto ? `<meta http-equiv="refresh" content="1;url=${target}">` : ""}
</head>
<body style="font-family: system-ui; display: grid; place-items: center; min-height: 90vh">
<main>
<p>Mock sign-in. Not OpenBot.</p>
<a id="mock-sign-in" href="${target}" style="display: inline-block; padding: 12px 20px; border: 1px solid; border-radius: 8px">Sign in as test person</a>
</main>
${auto ? `<script>setTimeout(function () { window.location.href = document.getElementById("mock-sign-in").href; }, 800);</script>` : ""}
</body>
</html>`;
  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function enter(url: URL, request: Request): Response {
  const failed = new Response(null, {
    status: 303,
    headers: { location: "/sign?native-sign-in=failed" },
  });
  if (ENTER_HEADER_CHECK) {
    // Only the phone app's web view, which says so in a header a link elsewhere can't set, and
    // never a request another site started.
    const shell = request.headers.get(SHELL_HEADER)?.toLowerCase() ?? "";
    const site = request.headers.get("sec-fetch-site")?.toLowerCase();
    const mode = request.headers.get("sec-fetch-mode")?.toLowerCase();
    if (!SHELL_PLATFORMS.has(shell)) return failed;
    // Only a load the web view started itself: no site, or `none`; a top-level navigation.
    if (site !== undefined && site !== "none") return failed;
    if (mode !== undefined && mode !== "navigate") return failed;
  }
  const ticket = tickets.get(url.searchParams.get("ticket") ?? "");
  const verifier = url.searchParams.get("verifier") ?? "";
  if (!ticket || ticket.used || ticket.expires < Date.now() || !verifier)
    return failed;
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  if (challenge !== ticket.challenge) return failed;
  ticket.used = true;
  mockSessionEnded = false;
  return new Response(null, {
    status: 303,
    headers: {
      location: ownPath(url.searchParams.get("to")),
      "set-cookie": `${MOCK_SESSION_COOKIE}=${MOCK_SESSION_VALUE}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800`,
    },
  });
}

// The server. ----------------------------------------------------------------------------------

async function start() {
  const spec = await generatedHandlersFromDisk();
  // The fake API is a `fetch` it installs on a target: here an object of the server's own.
  const notFound = () =>
    Promise.resolve(new Response("not found", { status: 404 }));
  const unused = { fetch: notFound as unknown as typeof fetch };
  const api = installFakeApi(unused, {
    origin: ORIGIN,
    realFetch: notFound as unknown as typeof fetch,
    groups: [
      { source: "extra", handlers: mockDataHandlers() },
      {
        source: "extra",
        handlers: extraHandlers({ agents: () => MOCK_BOTS.map((b) => b.id) }),
      },
      { source: "spec", handlers: spec },
    ],
    setTimer: (run, ms) => {
      setTimeout(run, ms);
    },
    now: () => performance.now(),
  });
  // The signed-in session's answers. A signed-out request is refused before it gets here.
  for (const [route, answer] of Object.entries(sessionApi(SESSION))) {
    if (answer) api.setAnswer(route as ApiRoute, answer);
  }
  const answer = unused.fetch;

  Bun.serve<undefined>({
    hostname: "127.0.0.1",
    port: PORT,
    websocket: {
      // The live socket (conversation events, a computer's screen): accepted, and nothing said.
      message() {},
      open(_socket: ServerWebSocket<undefined>) {},
    },
    async fetch(incoming, server) {
      const url = new URL(incoming.url);
      const path = url.pathname;

      if (path === "/__mock/session") {
        if (incoming.method === "POST") {
          const body = (await incoming.json().catch(() => ({}))) as {
            signedIn?: unknown;
          };
          if (typeof body.signedIn === "boolean")
            signedInByDefault = body.signedIn;
        }
        return Response.json({ signedIn: signedInByDefault });
      }

      if (path === "/api/auth/shell/config") {
        if (!HANDOFF) return new Response("Not found", { status: 404 });
        return Response.json({
          handoff: true,
          callback: "scheme",
          callbackUrl: "openbotshell://signed-in",
        });
      }

      if (
        path === "/api/auth/shell/handoff" ||
        path === "/api/auth/shell/enter"
      ) {
        if (!HANDOFF) return new Response("Not found", { status: 404 });
        return path.endsWith("/handoff")
          ? handoffPage(url)
          : enter(url, incoming);
      }

      if (incoming.headers.get("upgrade")?.toLowerCase() === "websocket") {
        if (server.upgrade(incoming)) return undefined;
        return new Response("expected a websocket upgrade", { status: 400 });
      }

      if (!path.startsWith("/api/"))
        return new Response("Not found", { status: 404 });

      const known = signedIn(incoming);
      if (path === "/api/auth/sign-out" && incoming.method === "POST") {
        signedInByDefault = false;
        // As a real server does: the session is over, so the same cookie no longer signs anybody in.
        if (hasMockCookie(incoming)) mockSessionEnded = true;
        return Response.json(
          { success: true },
          {
            headers: {
              "set-cookie": `${MOCK_SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`,
            },
          },
        );
      }
      if (!known) {
        if (path === "/api/auth/get-session") return Response.json(null);
        if (SIGNED_OUT_PATHS.some((pattern) => pattern.test(path)))
          return Response.json(
            { detail: "Sign in to continue." },
            { status: 401 },
          );
      }

      // Read here, so the fake API, which builds a Request of its own, gets the same body.
      const body =
        incoming.method === "GET" || incoming.method === "HEAD"
          ? undefined
          : await incoming.arrayBuffer();
      return answer(`${ORIGIN}${path}${url.search}`, {
        method: incoming.method,
        headers: incoming.headers,
        body,
      });
    },
  });

  console.log(
    `OpenBot MOCK server on ${ORIGIN} (${signedInByDefault ? "signed in" : "signed out unless the mock cookie is sent"}${HANDOFF ? "" : ", no sign-in hand-off"}). Organization ${ORGANIZATION}.`,
  );
}

if (import.meta.main) await start();
