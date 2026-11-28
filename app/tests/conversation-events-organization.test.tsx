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
import { channelListQueryOptions } from "@/lib/channels/queries";
import {
  type ChannelActivityEvent,
  useChannelEvents,
} from "@/lib/channels/use-channel-events";
import {
  currentOrganizationId,
  setCurrentOrganization,
} from "@/lib/organizations/current";
import {
  CONVERSATIONS_PATH,
  conversationPage,
  ORGANIZATION_PATH,
} from "./conversations-api";
import { settleReactWork } from "./settle-react-work";

/**
 * A person can be in several organizations, and the conversation events socket is theirs, not one organization's: the
 * server says which organization each event is about (`ChannelActivityEvent.organizationId`, api/asyncapi.yaml). The
 * sidebar takes only the events about the organization the person is working in. An event about another organization
 * changes nothing on screen and reads nothing again, and an event that names no organization (a server older than
 * this) is taken as it always was.
 *
 * Driven through the real hook and the real list query, with the server speaking on the socket.
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
  say(event: ChannelActivityEvent) {
    this.onmessage?.(
      new MessageEvent("message", { data: JSON.stringify(event) }),
    );
  }
}

/** The organization the person is working in: the one the conversations API is asked under here. */
const HERE = ORGANIZATION_PATH.split("/").at(-1) as string;
const ELSEWHERE = "org_elsewhere";
const OPENING = "Plan the launch";

function row(id: string) {
  return {
    id,
    name: "Researcher",
    agentIds: ["researcher"],
    threadId: id,
    active: true,
    lastMessageAt: "2026-11-19T09:00:00.000Z",
    summary: null,
    opening: OPENING,
    lastMessage: OPENING,
    lastMessageAgentId: null,
    createdAt: "2026-11-19T09:00:00.000Z",
    pinned: false,
    lastReadAt: null,
  };
}

let listReads = 0;
const NativeResponse = globalThis.Response;
const originalFetch = globalThis.fetch;
let originalWebSocket: typeof WebSocket;
let originalOrganization: string | undefined;
type Globals = { WebSocket: typeof WebSocket };
const globals = globalThis as unknown as Globals;

const serve = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input), "http://127.0.0.1:3010");
  if (
    url.pathname === CONVERSATIONS_PATH &&
    (init?.method ?? "GET").toUpperCase() === "GET"
  ) {
    listReads++;
    return NativeResponse.json(conversationPage([row("plan")]));
  }
  return NativeResponse.json({ error: "not served" }, { status: 404 });
}) as unknown as typeof fetch;

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://127.0.0.1:3010" });
  originalWebSocket = globals.WebSocket;
  globals.WebSocket = ServerSocket;
  globalThis.fetch = serve;
  originalOrganization = currentOrganizationId();
  setCurrentOrganization(HERE);
});
afterEach(() => {
  cleanup();
});
afterAll(async () => {
  await settleReactWork();
  globalThis.fetch = originalFetch;
  globals.WebSocket = originalWebSocket;
  setCurrentOrganization(originalOrganization);
  GlobalRegistrator.unregister();
});

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

const named = (
  channelId: string,
  summary: string,
  organizationId?: string,
): ChannelActivityEvent => ({
  channelId,
  ...(organizationId ? { organizationId } : {}),
  lastMessage: null,
  lastMessageAt: null,
  lastMessageAgentId: null,
  summary,
});

test("an event about another organization changes nothing and reads nothing again; one about this organization, or naming none, is taken", async () => {
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
  act(() => socket.onopen?.(new Event("open")));
  await waitFor(() =>
    expect(view.getByTestId("plan").textContent).toBe(OPENING),
  );
  await act(settleReactWork);
  const readsBefore = listReads;

  // Another organization's conversation with the same id, and one this sidebar has never seen: neither is here.
  act(() => {
    socket.say(named("plan", "Their launch", ELSEWHERE));
    socket.say(named("theirs", "Their offsite", ELSEWHERE));
  });
  await act(settleReactWork);
  expect(view.getByTestId("plan").textContent).toBe(OPENING);
  expect(view.queryByTestId("theirs")).toBeNull();
  expect(listReads).toBe(readsBefore);

  // This organization's own event is taken.
  act(() => socket.say(named("plan", "Launch plan", HERE)));
  await waitFor(() =>
    expect(view.getByTestId("plan").textContent).toBe("Launch plan"),
  );

  // So is one that names no organization, as every event did before organizations were named.
  act(() => socket.say(named("plan", "Launch plan, v2")));
  await waitFor(() =>
    expect(view.getByTestId("plan").textContent).toBe("Launch plan, v2"),
  );
  expect(listReads).toBe(readsBefore);
});
