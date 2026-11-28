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
 *        as test person". Following the link issues a single-use ticket that lasts 60 s.
 *        With auto=1 the page follows its link by itself after 800 ms. 400 without a valid C.
 *   GET  /api/auth/shell/enter?ticket=T&verifier=V&to=/path
 *        Loaded by the web view. With a known, unused, unexpired T whose C is base64url(sha256(V)):
 *        sets the cookie better-auth.session_token=mock and answers 303 to `to` (an own path, else /).
 *        Otherwise 303 to /sign?native-sign-in=failed, setting nothing.
 *   POST /api/auth/sign-out
 *        Ends the mock's session: its cookie stops counting until the next /enter.
 *
 * Signed in, the API answers as the workbench's app-home scene does (workbench/session.ts,
 * api/extraHandlers.ts and the spec's generated answers), with a fixed person (Sam Rivera, in Acme),
 * two Bots (General Assistant, Research Bot) and three conversations (Competitor pricing notes,
 * pinned and unread; Quarterly forecast; Trip to Lisbon), each with a short transcript. The live
 * socket the app opens is accepted and kept quiet.
 */

import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";
import type { ServerWebSocket } from "bun";
import { HttpResponse, http, type RequestHandler } from "msw";
import type { Bot, ConversationSummary } from "../src/lib/api/generated/model";
import { extraHandlers } from "./api/extraHandlers";
import { installFakeApi } from "./api/fakeApi";
import { pickAggregators } from "./api/handlers";
import type { ApiRoute } from "../../desktop/workbench/appContract";
import { DEFAULT_SESSION, sessionApi } from "./session";

const PORT = Number(process.env.SERVER_PORT ?? 3001);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const ORGANIZATION = DEFAULT_SESSION.signedIn
  ? DEFAULT_SESSION.organization.id
  : "default";
const API = `*/api/v2/organizations/:organizationId`;
/** The cookie that makes a request signed in, whatever the session's default. */
export const MOCK_SESSION_COOKIE = "better-auth.session_token";
const MOCK_SESSION_VALUE = "mock";
const HANDOFF = process.env.MOCK_NO_HANDOFF !== "1";
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

export const MOCK_BOTS: readonly Bot[] = [GENERAL_BOT, RESEARCH_BOT];

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
];

/** Each conversation's transcript: what the person asked, and the Bot's answer. */
function transcript(id: string) {
  const found = MOCK_CONVERSATIONS.find((one) => one.id === id);
  if (!found) return [];
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
  return MOCK_CONVERSATIONS.find((one) => one.threadId === threadId);
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
      const conversations = MOCK_CONVERSATIONS.filter(
        (one) =>
          (!botId || one.botIds.includes(botId)) &&
          (!q ||
            [one.name, one.summary, one.opening, one.lastMessage].some(
              (field) => field?.toLowerCase().includes(q),
            )),
      );
      return HttpResponse.json({ conversations, nextCursor: null });
    }),
    http.get(`${API}/conversations/:conversationId`, ({ params }) => {
      const found = MOCK_CONVERSATIONS.find(
        (one) => one.id === params.conversationId,
      );
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
    http.post(
      `${API}/conversations/:conversationId/activity`,
      () => new HttpResponse(null, { status: 204 }),
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
      };
      const threadId = body.threadId ?? "";
      const runId = body.runId ?? "mock-run";
      return new Response(
        [
          { type: "RUN_STARTED", threadId, runId },
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
  // The real sign-in completes before its ticket is issued. Chrome's first-run screens
  // and a person reading the confirmation can take longer than the ticket's whole lifetime.
  if (url.searchParams.get("confirm") === "1") {
    const ticket = base64url(randomBytes(24));
    tickets.set(ticket, {
      challenge,
      expires: Date.now() + TICKET_MS,
      used: false,
    });
    return new Response(null, {
      status: 303,
      headers: {
        location: `openbotshell://signed-in?ticket=${ticket}`,
        "cache-control": "no-store",
      },
    });
  }
  const target = escapeHtml(`?challenge=${challenge}&confirm=1`);
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

function enter(url: URL): Response {
  const failed = new Response(null, {
    status: 303,
    headers: { location: "/sign?native-sign-in=failed" },
  });
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
  for (const [route, answer] of Object.entries(sessionApi(DEFAULT_SESSION))) {
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
        return path.endsWith("/handoff") ? handoffPage(url) : enter(url);
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
