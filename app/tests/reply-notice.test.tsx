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
import { agentKeys } from "@/lib/agents/queries";
import {
  type BotAttention,
  type BotNotify,
  botLifecycleKeys,
} from "@/lib/bot-lifecycle/queries";
import { useChannelEvents } from "@/lib/channels/use-channel-events";
import { refreshNotificationPermission } from "@/lib/notifications/permission";
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
}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  queryClient.setQueryData(botLifecycleKeys.attention, {
    bots: options.bots ?? [attention("all")],
    lastPingId: null,
  });
  if (options.agents)
    queryClient.setQueryData(agentKeys.list(false), options.agents);
  function Page() {
    useChannelEvents();
    return null;
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
      tag: `openbot-reply-march-receipts-${event.lastMessageAt}`,
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
