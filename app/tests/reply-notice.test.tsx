import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { BotsNavBadge } from "@/components/bot-profile/attention";
import { agentKeys } from "@/lib/agents/queries";
import {
  type BotAttention,
  type BotNotify,
  botLifecycleKeys,
} from "@/lib/bot-lifecycle/queries";
import { useChannelEvents } from "@/lib/channels/use-channel-events";
import { refreshNotificationPermission } from "@/lib/notifications/permission";
import { forgetReplies, replyTiming } from "@/lib/notifications/reply-notice";
import { closeDesktop, launchDesktop } from "./desktop-notifications.fixture";
import { settleReactWork } from "./settle-react-work";

/**
 * A Bot's reply while OpenBot is out of sight raises a notice: "Expenses replied", over the reply's
 * first line, opening the conversation on a click. It comes off the app's one live socket, the way a
 * reply from a routine, a hand-off or another tab reaches the page, through the real hook that keeps
 * the roster live.
 */

/** The browser's socket, held so a test can speak as the server. */
class ServerSocket extends EventTarget implements WebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static opened: ServerSocket[] = [];
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;
  binaryType: BinaryType = "blob";
  bufferedAmount = 0;
  extensions = "";
  protocol = "";
  readyState = 1;
  onclose: WebSocket["onclose"] = null;
  onerror: WebSocket["onerror"] = null;
  onmessage: WebSocket["onmessage"] = null;
  onopen: WebSocket["onopen"] = null;
  readonly url: string;
  constructor(url: string | URL) {
    super();
    this.url = String(url);
    ServerSocket.opened.push(this);
  }
  close() {}
  send() {}
  /** One frame from the server, as `/api/channels/events` sends it. */
  say(event: unknown) {
    this.onmessage?.(
      new MessageEvent("message", { data: JSON.stringify(event) }),
    );
  }
}

/** The browser's `Notification`, recording what the page asked it to show. */
type Shown = {
  title: string;
  options: NotificationOptions & { extra?: { path: string } };
  onclick: (() => void) | null;
  closed: boolean;
};
const shown: Shown[] = [];
class BrowserNotification {
  static permission: NotificationPermission = "granted";
  static requestPermission = async () => BrowserNotification.permission;
  onclick: (() => void) | null = null;
  constructor(title: string, options: NotificationOptions = {}) {
    const record: Shown = { title, options, onclick: null, closed: false };
    shown.push(record);
    Object.defineProperty(this, "onclick", {
      set: (handler) => {
        record.onclick = handler;
      },
      get: () => record.onclick,
    });
    this.close = () => {
      record.closed = true;
    };
  }
  close() {}
}

type Globals = { Notification?: unknown; WebSocket: typeof WebSocket };
const globals = globalThis as unknown as Globals;
const originalNotification = globals.Notification;
let originalWebSocket: typeof WebSocket;
let originalFocus: typeof window.focus;
const originalFetch = globalThis.fetch;
/**
 * What `GET /api/bots/attention` answers now, read fresh when a reply is about to be announced.
 * Null: what the page was opened with.
 */
let served: { bots: BotAttention[]; lastPingId: null } | null = null;
let openedWith: { bots: BotAttention[]; lastPingId: null } = {
  bots: [],
  lastPingId: null,
};
/**
 * Each Bot's own notification setting, as `GET /api/bots/:id/lifecycle` answers it: what the person
 * saved, or "all" for a Bot they never set, as the server does. The attention list carries the same
 * setting for the Bots it names, and names only Bots with something waiting.
 */
let settings: Record<string, BotNotify> = {};
const serveAttention = (async (input: RequestInfo | URL) => {
  const url = String(input);
  if (url.endsWith("/api/bots/attention"))
    return Response.json(served ?? openedWith);
  const lifecycle = url.match(/\/api\/bots\/([^/]+)\/lifecycle$/);
  if (lifecycle?.[1]) {
    const agentId = decodeURIComponent(lifecycle[1]);
    const listed = (served ?? openedWith).bots.find(
      (bot) => bot.agentId === agentId,
    );
    return Response.json({
      lifecycle: {
        agentId,
        paused: false,
        pausedAt: null,
        notify: listed?.notify ?? settings[agentId] ?? "all",
      },
    });
  }
  if (url.endsWith("/api/proactive/suggestions"))
    return Response.json({ suggestions: [] });
  return Response.json({ error: "not served" }, { status: 404 });
}) as unknown as typeof fetch;
// A turn's replies settle quickly here; the rule is the same.
replyTiming.settleMs = 10;
let visibility: DocumentVisibilityState = "hidden";
let focused = false;
let windowFocused = 0;

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://127.0.0.1:3010" });
  originalWebSocket = globals.WebSocket;
  globals.WebSocket = ServerSocket;
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => visibility,
  });
  document.hasFocus = () => focused;
  originalFocus = window.focus;
  window.focus = () => {
    windowFocused++;
  };
});
beforeEach(() => {
  forgetReplies();
  served = null;
  settings = {};
  globalThis.fetch = serveAttention;
  shown.length = 0;
  ServerSocket.opened.length = 0;
  windowFocused = 0;
  // Out of sight: another app in front, or another tab.
  visibility = "hidden";
  focused = false;
  globals.Notification = BrowserNotification;
  BrowserNotification.permission = "granted";
  refreshNotificationPermission();
});
afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  closeDesktop();
  globals.Notification = originalNotification;
  refreshNotificationPermission();
});
afterAll(async () => {
  await settleReactWork();
  globals.WebSocket = originalWebSocket;
  window.focus = originalFocus;
  GlobalRegistrator.unregister();
});

function attention(notify: BotNotify): BotAttention {
  return {
    agentId: "expenses",
    name: "Expenses",
    questions: 0,
    approvals: 0,
    handoffs: 0,
    unread: 0,
    paused: false,
    notify,
    items: 0,
    tasks: { needsInput: 0, ready: 0, failed: 0 },
  };
}

/** The page, with the hook that keeps the roster live, and the Bots it knows. */
async function openPage(options: {
  bots?: BotAttention[];
  agents?: { id: string; name: string }[];
  badge?: boolean;
}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  openedWith = {
    bots: options.bots ?? [attention("all")],
    lastPingId: null,
  };
  queryClient.setQueryData(botLifecycleKeys.attention, openedWith);
  if (options.agents)
    queryClient.setQueryData(agentKeys.list(false), options.agents);
  function Page() {
    useChannelEvents();
    // The sidebar's badge, which raises "needs you" off the same attention list.
    return options.badge ? <BotsNavBadge /> : null;
  }
  const router = createRouter({
    routeTree: createRootRoute({ component: Page }),
    history: createMemoryHistory({ initialEntries: ["/bots"] }),
  });
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  await waitFor(() => expect(ServerSocket.opened).toHaveLength(1));
  const socket = ServerSocket.opened[0] as ServerSocket;
  return { socket, router };
}

let replies = 0;
/** A Bot's reply, as `recordActivity` announces it: a fresh moment each time. */
function reply(overrides: Record<string, unknown> = {}) {
  replies++;
  return {
    channelId: "march-receipts",
    memberIds: ["user"],
    lastMessage: "Categorized three expenses. The receipts are in Drive.",
    firstLine: "Categorized three expenses.",
    lastMessageAt: `2026-11-08T10:00:${String(replies).padStart(2, "0")}.000Z`,
    lastMessageAgentId: "expenses",
    ...overrides,
  };
}

/** Long enough for a notice that was going to be shown to have been. */
async function settle() {
  await act(settleReactWork);
  await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
}

test("a Bot's reply while OpenBot is out of sight shows one notice, naming the Bot over the reply's first line, and a click opens the conversation", async () => {
  const { socket, router } = await openPage({});
  const event = reply();

  act(() => socket.say(event));
  // Reported again at the same moment, as a filled-in placeholder is: the same reply.
  act(() => socket.say(event));
  await settle();

  expect(shown.map(({ title, options }) => ({ title, ...options }))).toEqual([
    {
      title: "Expenses replied",
      body: "Categorized three expenses.",
      // The conversation's tag, which its "needs you" notice shares: one notice per conversation.
      tag: "openbot-march-receipts",
      extra: { path: "/channel/march-receipts" },
    },
  ]);

  const [notice] = shown;
  act(() => notice?.onclick?.());
  await waitFor(() =>
    expect(router.state.location.pathname).toBe("/channel/march-receipts"),
  );
  expect(windowFocused).toBe(1);
  expect(notice?.closed).toBe(true);
});

test("a tab that is visible but behind another app still shows it", async () => {
  visibility = "visible";
  focused = false;
  const { socket } = await openPage({});

  act(() => socket.say(reply()));

  await waitFor(() =>
    expect(shown.map((notice) => notice.title)).toEqual(["Expenses replied"]),
  );
});

test("no notice while the person is looking at OpenBot", async () => {
  visibility = "visible";
  focused = true;
  const { socket } = await openPage({});

  act(() => socket.say(reply()));
  await settle();

  expect(shown).toEqual([]);
});

test("no notice for the person's own message", async () => {
  const { socket } = await openPage({});

  act(() =>
    socket.say(
      reply({
        lastMessageAgentId: null,
        lastMessage: "Sort my receipts",
        firstLine: undefined,
      }),
    ),
  );
  await settle();

  expect(shown).toEqual([]);
});

test("no notice for a name, a pin or a working dot, which are not replies", async () => {
  const { socket } = await openPage({});

  act(() => {
    socket.say(
      reply({
        lastMessage: null,
        firstLine: undefined,
        summary: "March receipts",
      }),
    );
    socket.say(reply({ lastMessage: null, firstLine: undefined, busy: false }));
  });
  await settle();

  expect(shown).toEqual([]);
});

for (const notify of ["needs_input", "none"] as const) {
  test(`no notice from a Bot set to ${notify}`, async () => {
    const { socket } = await openPage({ bots: [attention(notify)] });

    act(() => socket.say(reply()));
    await settle();

    expect(shown).toEqual([]);
  });
}

test("no notice when notifications are not allowed", async () => {
  BrowserNotification.permission = "denied";
  refreshNotificationPermission();
  const { socket } = await openPage({});

  act(() => socket.say(reply()));
  await settle();

  expect(shown).toEqual([]);
});

test("a Bot the attention list does not name is named from the Bots list, and says everything", async () => {
  const { socket } = await openPage({
    bots: [],
    agents: [{ id: "expenses", name: "Expenses" }],
  });

  act(() => socket.say(reply()));

  await waitFor(() =>
    expect(shown.map((notice) => notice.title)).toEqual(["Expenses replied"]),
  );
});

const DESKTOP_REPLY = {
  title: "Expenses replied",
  body: "Categorized three expenses.",
  // The page a click opens, from the notification centre too.
  path: "/channel/march-receipts",
  // The conversation's: Windows replaces a toast of the same tag rather than stacking another.
  tag: "openbot-march-receipts",
};

test("in OpenBot Desktop the desktop app shows it, naming the conversation a click opens", async () => {
  const desktop = launchDesktop({ plugin: true });
  refreshNotificationPermission();
  await settle();
  const { socket } = await openPage({});

  act(() => socket.say(reply()));

  await waitFor(() => expect(desktop.shown()).toEqual([DESKTOP_REPLY]));
  expect(desktop.toDesktopNotify()).toHaveLength(1);
});

test("in a desktop app from before its own notify, the plugin shows it, with the same conversation", async () => {
  const desktop = launchDesktop({ plugin: true, notifyCommand: false });
  refreshNotificationPermission();
  await settle();
  const { socket } = await openPage({});

  act(() => socket.say(reply()));

  await waitFor(() => expect(desktop.shown()).toEqual([DESKTOP_REPLY]));
});

test("in OpenBot Desktop no notice while the person is looking at it", async () => {
  visibility = "visible";
  focused = true;
  const desktop = launchDesktop({ plugin: true });
  refreshNotificationPermission();
  await settle();
  const { socket } = await openPage({});

  act(() => socket.say(reply()));
  await settle();

  expect(desktop.shown()).toEqual([]);
});

/*
 * ONE MOMENT, ONE NOTICE. Measured on Windows (#1265): one turn that ended asking the person which
 * colour of apple they prefer raised four toasts, "needs you", "replied" twice with the same words,
 * and "replied" again with the server's "A question needs your answer" line.
 */

/** A Bot's turn as the socket carries it: busy on, what it said, busy off. */
function aTurn(socket: ServerSocket, ...said: Record<string, unknown>[]) {
  act(() => socket.say({ ...reply(), busy: true }));
  for (const each of said) act(() => socket.say(reply(each)));
  act(() => socket.say({ ...reply(), busy: false }));
}

const ASKED = {
  lastMessage:
    "I've asked: which colour of apple do you prefer, red or green? I'll wait for your answer.",
  firstLine:
    "I've asked: which colour of apple do you prefer, red or green? I'll wait for your answer.",
};

test("a turn that ends in a question gives exactly one notice, and it is the question's", async () => {
  const { socket } = await openPage({ badge: true });
  await settle();
  // What the server says once the turn ends: the Bot waits on the person, in this conversation.
  served = {
    bots: [{ ...attention("all"), questions: 1, waitingIn: "march-receipts" }],
    lastPingId: null,
  };

  aTurn(
    socket,
    ASKED,
    // The same words again, at another moment: one turn reports what it said more than once.
    ASKED,
    // The server's own line for the question, which is a Bot's message too.
    {
      lastMessage:
        "A question needs your answer: Which colour of apple do you prefer?",
      firstLine:
        "A question needs your answer: Which colour of apple do you prefer?",
    },
  );

  await waitFor(() =>
    expect(shown.map(({ title, options }) => [title, options.tag])).toEqual([
      ["Expenses needs you", "openbot-march-receipts"],
    ]),
  );
  await settle();
  expect(shown).toHaveLength(1);
});

test("a reply already announced, reported again in a later moment, gives no second notice", async () => {
  const { socket } = await openPage({});

  aTurn(socket, ASKED);
  await waitFor(() => expect(shown).toHaveLength(1));
  aTurn(socket, ASKED);
  await settle();

  expect(shown.map((notice) => notice.title)).toEqual(["Expenses replied"]);
});

test("a turn's replies give one notice, the last thing it said, once the turn has ended", async () => {
  const { socket } = await openPage({});

  act(() => socket.say({ ...reply(), busy: true }));
  act(() => socket.say(reply({ firstLine: "Looking at your receipts." })));
  await settle();
  // Still working: nothing yet.
  expect(shown).toEqual([]);
  act(() => socket.say(reply({ firstLine: "Categorized three expenses." })));
  act(() => socket.say({ ...reply(), busy: false }));

  await waitFor(() =>
    expect(shown.map(({ options }) => options.body)).toEqual([
      "Categorized three expenses.",
    ]),
  );
});

test("a Bot set to only when it needs the person raises no reply notice, though nothing of it waits", async () => {
  // Measured on Windows: with nothing waiting, the Bot was missing from the attention list, and the
  // missing entry was read as "Everything".
  settings = { expenses: "needs_input" };
  const { socket } = await openPage({ bots: [] });

  aTurn(socket, { firstLine: "Categorized three expenses." });
  await settle();
  await act(() => new Promise((resolve) => setTimeout(resolve, 50)));

  expect(shown).toEqual([]);
});

test("no notice of either kind while the person is looking at OpenBot", async () => {
  visibility = "visible";
  focused = true;
  const { socket } = await openPage({ badge: true });
  await settle();
  served = {
    bots: [{ ...attention("all"), questions: 1, waitingIn: "march-receipts" }],
    lastPingId: null,
  };

  aTurn(socket, ASKED);
  await settle();
  await act(() => new Promise((resolve) => setTimeout(resolve, 50)));

  expect(shown).toEqual([]);
});
