import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
import type { Message, RunAgentInput } from "@ag-ui/core";
import { RunAgentInputSchema } from "@ag-ui/core/schemas";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { type InfiniteData, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ChannelChat } from "@/components/channels/channel-chat";
import { GALLERY as CARDS } from "@/components/gallery/cards";
import type { BotNotify } from "@/lib/bot-lifecycle/queries";
import {
  type AgentChannel,
  type ChannelPage,
  type ChannelSummary,
  channelKeys,
} from "@/lib/channels/queries";
import { useChannelEvents } from "@/lib/channels/use-channel-events";
import { GALLERY_COMPONENTS } from "@/lib/copilot/gallery-registry";
import { CopilotProvider } from "@/lib/copilot/provider";
import { deploymentKeys } from "@/lib/deployment/queries";
import { refreshNotificationPermission } from "@/lib/notifications/permission";
import { forgetReplies, replyTiming } from "@/lib/notifications/reply-notice";
import { queryClient } from "@/query-client";
import { settleReactWork } from "./settle-react-work";

/**
 * A Bot whose whole answer is something it drew raises the same "replied" notice a Bot that answers
 * in words does.
 *
 * Reported with the trip budget starter: OpenBot drew the budget, the person was in another app,
 * and no notice came, where the Bot's replies in words always raised one. The turn said nothing, so
 * the conversation told the roster nothing, and the notice is raised off what the roster is told.
 *
 * End to end in the app: the real chat running the turn through the app's own CopilotKit provider,
 * against a runtime that streams what the real one does for a drawn interface (the call and the
 * activity the middleware makes of it), and the real roster socket and notifier, with the server's
 * part played at its boundary: what a conversation reports is announced back on the socket, as
 * `recordActivity` and `signalChannelBusy` announce it.
 */

const BOT = "trip-bot";
const channel: AgentChannel = {
  id: "trip-channel",
  name: "Weekend away",
  agentIds: [BOT],
  threadId: "trip-thread",
  active: true,
  lastMessageAt: "2026-11-09T00:00:00.000Z",
};
const NativeResponse = globalThis.Response;
const ASK =
  "Build an interactive weekend trip budget in this conversation. Start with transport $100, lodging $200 and food $80.";

/** What the Bot draws, as a model writes it for `generateSandboxedUi`. */
const BUDGET = {
  initialHeight: 320,
  placeholderMessages: ["Building your trip budget"],
  css: ".budget { padding: 16px; }",
  html: `<div class="budget"><h2>Weekend trip budget</h2><label>Transport <input id="transport" value="100"></label><label>Lodging <input id="lodging" value="200"></label><label>Food <input id="food" value="80"></label><p>Total: <strong id="total">$380</strong></p></div>`,
  jsFunctions: "function total() { return 380; }",
};

/** The real Record card, registered as Vite would have; see `off-screen-tool-calls.test.tsx`. */
const RECORD = CARDS.find((candidate) => candidate.name === "showRecord");
if (!RECORD) throw new Error("The Record card is not in the gallery.");

type Call = { name: string; args: Record<string, unknown> };
/** What the Bot's first run calls. The run after it, carrying the call's result, says nothing. */
let call: Call;
/** What the run carrying the call's result says, when it says anything. */
let closing: string | null = null;
let runs: RunAgentInput[] = [];
let stored: Message[] = [];
/** Every line the conversation reported to the roster, as `POST /api/channels/:id/activity`. */
let reported: { agentId: string | null; text: string }[] = [];
let notify: BotNotify = "all";
let originalFetch: typeof fetch;
let originalSocket: typeof WebSocket;
let visibility: DocumentVisibilityState = "visible";
let focused = true;

/** The roster's socket, held so the server's announcements can be spoken on it. */
class ServerSocket {
  static readonly OPEN = 1;
  static opened: ServerSocket[] = [];
  readyState = 1;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  readonly url: string;
  constructor(url: string | URL) {
    this.url = String(url);
    ServerSocket.opened.push(this);
  }
  send() {}
  close() {}
}

/** Announce `event` to every roster socket, as the server's channel events route does. */
function announce(event: Record<string, unknown>) {
  for (const socket of ServerSocket.opened)
    if (socket.url.includes("/api/channels/events"))
      socket.onmessage?.({ data: JSON.stringify(event) });
}

/** The browser's `Notification`, recording what the page asked it to show. */
const shown: { title: string; body?: string; tag?: string }[] = [];
class BrowserNotification {
  static permission: NotificationPermission = "granted";
  static requestPermission = async () => BrowserNotification.permission;
  onclick: (() => void) | null = null;
  constructor(title: string, options: NotificationOptions = {}) {
    shown.push({ title, body: options.body, tag: options.tag });
  }
  close() {}
}
const globals = globalThis as unknown as { Notification?: unknown };
const originalNotification = globals.Notification;

function sse(events: unknown[]) {
  return new NativeResponse(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
}

/**
 * The Bot's runs. The first draws `call` and says nothing. The next carries the call's result back
 * and finishes without a word, which is how the trip budget turn ended.
 */
function runEvents(input: RunAgentInput): unknown[] {
  const started = {
    type: "RUN_STARTED",
    threadId: input.threadId,
    runId: input.runId,
  };
  const finished = {
    type: "RUN_FINISHED",
    threadId: input.threadId,
    runId: input.runId,
  };
  if (input.messages.at(-1)?.role === "tool") {
    if (closing === null) {
      stored = [...input.messages];
      return [started, finished];
    }
    const said = `reply-${input.runId}`;
    stored = [
      ...input.messages,
      { id: said, role: "assistant", content: closing },
    ];
    return [
      started,
      { type: "TEXT_MESSAGE_START", messageId: said, role: "assistant" },
      { type: "TEXT_MESSAGE_CONTENT", messageId: said, delta: closing },
      { type: "TEXT_MESSAGE_END", messageId: said },
      finished,
    ];
  }
  const id = "call-draw";
  const assistant = {
    id: `assistant-${input.runId}`,
    role: "assistant" as const,
    toolCalls: [
      {
        id,
        type: "function" as const,
        function: { name: call.name, arguments: JSON.stringify(call.args) },
      },
    ],
  };
  stored = [...input.messages, assistant];
  const drawing =
    call.name === "generateSandboxedUi"
      ? [
          // What the runtime's middleware makes of the call's arguments: the interface itself.
          {
            type: "ACTIVITY_SNAPSHOT",
            messageId: `${id}-activity`,
            activityType: "open-generative-ui",
            content: {
              initialHeight: BUDGET.initialHeight,
              css: BUDGET.css,
              cssComplete: true,
              html: [BUDGET.html],
              htmlComplete: true,
              jsFunctions: BUDGET.jsFunctions,
              jsFunctionsComplete: true,
              generating: false,
            },
          },
        ]
      : [];
  return [
    started,
    {
      type: "TOOL_CALL_START",
      toolCallId: id,
      toolCallName: call.name,
      parentMessageId: assistant.id,
    },
    ...drawing,
    {
      type: "TOOL_CALL_ARGS",
      toolCallId: id,
      delta: JSON.stringify(call.args),
    },
    { type: "TOOL_CALL_END", toolCallId: id },
    finished,
  ];
}

async function serve(url: URL, request: Request): Promise<Response> {
  const path = url.pathname;
  // The server's part of the roster: what a conversation reports is announced to its members.
  const activity = path.match(/^\/api\/channels\/([^/]+)\/activity$/);
  if (activity?.[1] && request.method === "POST") {
    const body = (await request.json()) as {
      agentId: string | null;
      at: string;
      text: string;
    };
    reported.push({ agentId: body.agentId, text: body.text });
    announce({
      channelId: activity[1],
      memberIds: ["user"],
      lastMessage: body.text,
      lastMessageAt: body.at,
      lastMessageAgentId: body.agentId,
      ...(body.agentId !== null ? { firstLine: body.text } : {}),
    });
    return new NativeResponse(null, { status: 204 });
  }
  const busy = path.match(/^\/api\/channels\/([^/]+)\/busy$/);
  if (busy?.[1] && request.method === "POST") {
    const body = (await request.json()) as { busy: boolean };
    announce({
      channelId: busy[1],
      memberIds: ["user"],
      lastMessage: null,
      lastMessageAt: null,
      lastMessageAgentId: null,
      busy: body.busy,
      work: [],
      workAt: new Date().toISOString(),
    });
    return new NativeResponse(null, { status: 204 });
  }
  // The Bot's own notification setting, and nothing of it waiting on the person.
  if (path === "/api/bots/attention")
    return NativeResponse.json({ bots: [], lastPingId: null });
  if (path === `/api/bots/${BOT}/lifecycle`)
    return NativeResponse.json({
      lifecycle: { agentId: BOT, paused: false, pausedAt: null, notify },
    });
  if (path === "/api/agents")
    return NativeResponse.json({
      agents: [{ id: BOT, name: "Trip Planner" }],
    });
  if (path === `/api/agents/${BOT}`)
    return NativeResponse.json({
      agent: {
        id: BOT,
        name: "Trip Planner",
        visibility: "public",
        canManage: true,
      },
    });
  if (path === "/api/components/catalogue")
    return NativeResponse.json({ added: [] });
  if (path === `/api/components/for-agent/${BOT}`)
    return NativeResponse.json({
      components: [{ name: "showRecord", description: "Show one record." }],
    });
  if (path === "/api/components/showRecord/decision")
    return NativeResponse.json({ allowed: true });
  if (path === "/api/admin/enterprise/me")
    return NativeResponse.json({ capabilities: {}, enforced: false });
  if (path.endsWith("/info"))
    return NativeResponse.json({
      version: "fixture",
      agents: { [BOT]: { description: "Fixture", capabilities: {} } },
      mode: "sse",
      telemetryDisabled: true,
    });
  if (path.endsWith("/connect")) {
    const { threadId } = (await request.json()) as { threadId: string };
    return sse([
      { type: "RUN_STARTED", threadId, runId: "join" },
      { type: "MESSAGES_SNAPSHOT", messages: stored },
      { type: "RUN_FINISHED", threadId, runId: "join" },
    ]);
  }
  if (path.endsWith("/run")) {
    const body = RunAgentInputSchema.parse(await request.json());
    runs.push(body);
    return sse(runEvents(body));
  }
  if (path === `/api/threads/${channel.threadId}/messages`)
    return NativeResponse.json({ messages: stored });
  if (/^\/api\/plugins\/for\/[^/]+$/.test(path))
    return NativeResponse.json({ skills: [], tools: [] });
  if (path === "/api/voice/sessions")
    return NativeResponse.json({ sessions: [], nextCursor: null });
  if (/^\/api\/approvals\/threads\/[^/]+$/.test(path))
    return NativeResponse.json({ asksEveryStep: false });
  return NativeResponse.json({ error: "Not found" }, { status: 404 });
}

// A turn's replies settle quickly here; the rule is the same.
replyTiming.settleMs = 10;

beforeAll(() => {
  GALLERY_COMPONENTS.push(RECORD);
  GlobalRegistrator.register({ url: "http://127.0.0.1:3010" });
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => visibility,
  });
  document.hasFocus = () => focused;
  originalFetch = globalThis.fetch;
  originalSocket = globalThis.WebSocket;
  globalThis.WebSocket = ServerSocket as unknown as typeof WebSocket;
  globalThis.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = new URL(
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url,
        "http://127.0.0.1:3010",
      );
      return serve(
        url,
        input instanceof Request ? input : new Request(url, init),
      );
    },
    { preconnect: () => undefined },
  );
});
beforeEach(() => {
  forgetReplies();
  runs = [];
  stored = [];
  reported = [];
  closing = null;
  shown.length = 0;
  ServerSocket.opened.length = 0;
  notify = "all";
  visibility = "visible";
  focused = true;
  globals.Notification = BrowserNotification;
  BrowserNotification.permission = "granted";
  refreshNotificationPermission();
  sessionStorage.clear();
  queryClient.clear();
  // This deployment draws interfaces its Bots write, so the browser offers them the tool.
  queryClient.setQueryData(deploymentKeys.capabilities(), {
    generativeUi: true,
    selfHostBanner: false,
    localEvaluation: false,
    edition: "team",
    transcription: false,
    voice: false,
  });
  const summary: ChannelSummary = {
    ...channel,
    summary: null,
    lastMessage: null,
    lastMessageAgentId: null,
    createdAt: "2026-11-09T00:00:00.000Z",
    pinned: false,
    lastReadAt: null,
  };
  queryClient.setQueryData<InfiniteData<ChannelPage>>(channelKeys.list(), {
    pages: [{ channels: [summary], nextCursor: null }],
    pageParams: [""],
  });
});
afterEach(() => {
  cleanup();
  globals.Notification = originalNotification;
  refreshNotificationPermission();
});
afterAll(async () => {
  await settleReactWork();
  GALLERY_COMPONENTS.splice(GALLERY_COMPONENTS.indexOf(RECORD), 1);
  globalThis.fetch = originalFetch;
  globalThis.WebSocket = originalSocket;
  GlobalRegistrator.unregister();
});

/** The signed-in app open on the Bot's conversation, with the roster's socket live beside it. */
function openConversation() {
  function Page() {
    useChannelEvents();
    return (
      <CopilotProvider>
        <ChannelChat channel={channel} runtimeAgentId={BOT} />
      </CopilotProvider>
    );
  }
  const router = createRouter({
    routeTree: createRootRoute({ component: Page }),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

/**
 * The person asks, and then, if `away`, switches to another app straight away. Resolves once the
 * turn is over: both runs have gone, and the conversation has taken its working dot down.
 */
async function ask(away: boolean) {
  const view = openConversation();
  const user = userEvent.setup({ document: view.container.ownerDocument });
  await user.type(
    await view.findByRole("textbox", { name: "Message" }, { timeout: 5000 }),
    ASK,
  );
  await user.click(view.getByRole("button", { name: "Send message" }));
  if (away) focused = false;
  await waitFor(() => expect(runs).toHaveLength(2), { timeout: 5000 });
  await waitFor(
    () =>
      expect(view.queryByRole("button", { name: "Stop the Bot" })).toBeNull(),
    { timeout: 5000 },
  );
  await settleReactWork();
  // Long enough for a notice that was going to be shown to have been.
  await new Promise((resolve) => setTimeout(resolve, 100));
  return view;
}

test("a turn whose whole answer is an interface the Bot drew raises one notice while OpenBot is out of sight, over the interface's title", async () => {
  call = { name: "generateSandboxedUi", args: BUDGET };
  await ask(true);

  expect(shown).toEqual([
    {
      title: "Trip Planner replied",
      body: "Weekend trip budget",
      tag: `openbot-${channel.id}`,
    },
  ]);
});

test("a turn whose whole answer is a card raises one notice, over the card's title", async () => {
  call = {
    name: "showRecord",
    args: {
      title: "Northwind Traders",
      subtitle: "Enterprise account",
      fields: [{ label: "Owner", value: "Priya Raman" }],
    },
  };
  await ask(true);

  expect(shown).toEqual([
    {
      title: "Trip Planner replied",
      body: "Northwind Traders",
      tag: `openbot-${channel.id}`,
    },
  ]);
});

test("no notice for a drawn answer while the person is looking at OpenBot, though the conversation shows it as the last thing said", async () => {
  call = { name: "generateSandboxedUi", args: BUDGET };
  await ask(false);

  expect(reported.filter((line) => line.agentId === BOT)).toEqual([
    { agentId: BOT, text: "Weekend trip budget" },
  ]);
  expect(shown).toEqual([]);
});

test("no notice for a drawn answer from a Bot set to only when it needs the person", async () => {
  notify = "needs_input";
  call = { name: "generateSandboxedUi", args: BUDGET };
  await ask(true);

  expect(reported.filter((line) => line.agentId === BOT)).toEqual([
    { agentId: BOT, text: "Weekend trip budget" },
  ]);
  expect(shown).toEqual([]);
});

test("a turn that draws and then says something raises one notice, over what it said last", async () => {
  call = { name: "generateSandboxedUi", args: BUDGET };
  closing = "Change any cost and the total updates.";
  await ask(true);

  expect(shown).toEqual([
    {
      title: "Trip Planner replied",
      body: "Change any cost and the total updates.",
      tag: `openbot-${channel.id}`,
    },
  ]);
});
