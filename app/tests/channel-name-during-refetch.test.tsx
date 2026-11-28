import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  QueryClient,
  QueryClientProvider,
  useInfiniteQuery,
} from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { conversationTitle } from "@/lib/channels/label";
import {
  type ChannelSummary,
  channelListQueryOptions,
} from "@/lib/channels/queries";
import { useChannelEvents } from "@/lib/channels/use-channel-events";
import { CONVERSATIONS_PATH, conversationPage } from "./conversations-api";
import { settleReactWork } from "./settle-react-work";

/**
 * A subagent and its parent named in the same pass.
 *
 * A conversation that starts a subagent gets its name at about the moment the subagent's own
 * conversation gets one, and the server announces the subagent's first. The sidebar has not read
 * the subagent's conversation yet, so that announcement reads the list again. The parent's name
 * then patches the parent's row while that read is still on its way, and the read, begun before the
 * parent was named, lands after and puts back a row with no name. Nothing read the list again, so
 * the sidebar kept the parent's first message as its name until a reload.
 *
 * Driven through the real hook and the real list query, with the server's answer held until the
 * test lets it land, so the order is the one that went wrong and never a matter of timing.
 */

/** The browser's socket, held so the test can speak as the server. */
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
  /** One frame from the server, as the conversation events socket sends it. */
  say(event: unknown) {
    this.onmessage?.(
      new MessageEvent("message", { data: JSON.stringify(event) }),
    );
  }
}

const OPENING = "Plan the team offsite for March";
const PARENT_NAME = "Team offsite plan";
const CHILD_NAME = "Venue research";

function row(id: string, fields: Partial<ChannelSummary> = {}) {
  return {
    id,
    name: "Researcher",
    agentIds: ["researcher"],
    threadId: id,
    active: true,
    lastMessageAt: "2026-11-16T09:00:00.000Z",
    summary: null,
    opening: OPENING,
    lastMessage: OPENING,
    lastMessageAgentId: null,
    createdAt: "2026-11-16T09:00:00.000Z",
    pinned: false,
    lastReadAt: null,
    ...fields,
  };
}

/** What the server holds now. The parent has its name only once the test says it was saved. */
const server = { parentNamed: false, childExists: false };

function listNow() {
  const rows = [
    row("parent", server.parentNamed ? { summary: PARENT_NAME } : {}),
  ];
  if (server.childExists)
    rows.push(row("child", { summary: CHILD_NAME, opening: null }));
  return conversationPage(rows);
}

/** A list read the test holds, with what the server held when it began. */
let held: { body: unknown; land: () => void } | null = null;
let holdNextRead = false;
let listReads = 0;

const NativeResponse = globalThis.Response;
const originalFetch = globalThis.fetch;
let originalWebSocket: typeof WebSocket;
type Globals = { WebSocket: typeof WebSocket };
const globals = globalThis as unknown as Globals;

const serve = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input), "http://127.0.0.1:3010");
  if (
    url.pathname === CONVERSATIONS_PATH &&
    (init?.method ?? "GET").toUpperCase() === "GET"
  ) {
    listReads++;
    // Read now, answered later: what a slow list read sees is the moment it began.
    const body = listNow();
    if (!holdNextRead) return NativeResponse.json(body);
    holdNextRead = false;
    return new Promise<Response>((resolve) => {
      held = { body, land: () => resolve(NativeResponse.json(body)) };
    });
  }
  return NativeResponse.json({ error: "not served" }, { status: 404 });
}) as unknown as typeof fetch;

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://127.0.0.1:3010" });
  originalWebSocket = globals.WebSocket;
  globals.WebSocket = ServerSocket;
  globalThis.fetch = serve;
});
afterEach(() => {
  cleanup();
});
afterAll(async () => {
  await settleReactWork();
  globalThis.fetch = originalFetch;
  globals.WebSocket = originalWebSocket;
  GlobalRegistrator.unregister();
});

/** The sidebar's list, each row by the name the sidebar gives it, kept live by the real hook. */
function Sidebar() {
  useChannelEvents();
  const { data } = useInfiniteQuery(channelListQueryOptions());
  return (
    <ul>
      {(data ?? []).map((channel) => (
        <li key={channel.id} data-testid={channel.id}>
          {conversationTitle(channel)}
        </li>
      ))}
    </ul>
  );
}

/** A conversation's name, as the server announces a summary written or a rename. */
function named(channelId: string, summary: string) {
  return {
    channelId,
    lastMessage: null,
    lastMessageAt: null,
    lastMessageAgentId: null,
    summary,
  };
}

test("a parent named while a subagent's read of the list is on its way keeps its name", async () => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  const router = createRouter({
    routeTree: createRootRoute({ component: Sidebar }),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  await waitFor(() => expect(ServerSocket.opened).toHaveLength(1));
  const socket = ServerSocket.opened[0] as ServerSocket;
  // The socket opening reads the list once more, as a reconnect does; let that settle first.
  act(() => socket.onopen?.(new Event("open")));
  await waitFor(() =>
    expect(view.getByTestId("parent").textContent).toBe(OPENING),
  );
  await act(settleReactWork);

  // The parent started a subagent: its conversation exists, and the next read of the list is slow.
  server.childExists = true;
  holdNextRead = true;
  const readsBefore = listReads;

  // Both named in the same pass, the subagent first. Its conversation is not on the list, so the
  // list is read again; the parent's row is, so it is patched while that read is on its way.
  act(() => {
    socket.say(named("child", CHILD_NAME));
    socket.say(named("parent", PARENT_NAME));
  });
  await waitFor(() =>
    expect(view.getByTestId("parent").textContent).toBe(PARENT_NAME),
  );
  await waitFor(() => expect(held).not.toBeNull());
  expect(listReads).toBe(readsBefore + 1);

  // The parent's name is saved now; the held read began before, and lands without it.
  server.parentNamed = true;
  const read = held as unknown as { body: unknown; land: () => void };
  expect(JSON.stringify(read.body)).not.toContain(PARENT_NAME);
  await act(async () => read.land());
  // The subagent's row comes only from that read, so seeing it means the stale read has landed.
  await waitFor(() =>
    expect(view.getByTestId("child").textContent).toBe(CHILD_NAME),
  );

  // The list is read once more after it, and the parent has its name.
  await waitFor(() =>
    expect(view.getByTestId("parent").textContent).toBe(PARENT_NAME),
  );
  await act(settleReactWork);
  expect(view.getByTestId("parent").textContent).toBe(PARENT_NAME);
  expect(listReads).toBe(readsBefore + 2);
});
