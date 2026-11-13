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
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AppSidebar } from "@/components/app-sidebar/app-sidebar";
import { SidebarProvider } from "@/components/ui/sidebar";
import { agentKeys } from "@/lib/agents/queries";
import { authKeys } from "@/lib/auth/queries";
import { botLifecycleKeys } from "@/lib/bot-lifecycle/queries";
import { browserKeys } from "@/lib/browser/queries";
import { type ChannelSummary, channelKeys } from "@/lib/channels/queries";
import { deploymentKeys } from "@/lib/deployment/queries";
import { proactiveKeys } from "@/lib/proactive";
import { userPreferencesQueryOptions } from "@/lib/settings/message-list";

// Keep the sidebar's live-update socket offline; these tests exercise HTTP pagination.
class OfflineWebSocket extends EventTarget implements WebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;
  binaryType: BinaryType = "blob";
  bufferedAmount = 0;
  extensions = "";
  protocol = "";
  readyState = 0;
  onclose: WebSocket["onclose"] = null;
  onerror: WebSocket["onerror"] = null;
  onmessage: WebSocket["onmessage"] = null;
  onopen: WebSocket["onopen"] = null;
  readonly url: string;
  constructor(url: string | URL) {
    super();
    this.url = String(url);
  }
  close() {}
  send() {}
}

class ScrollObserver implements IntersectionObserver {
  static active = new Set<ScrollObserver>();
  readonly root;
  readonly rootMargin;
  readonly thresholds = [0];
  private targets = new Set<Element>();
  constructor(
    private callback: IntersectionObserverCallback,
    options: IntersectionObserverInit = {},
  ) {
    this.root = options.root ?? null;
    this.rootMargin = options.rootMargin ?? "0px";
    ScrollObserver.active.add(this);
  }
  observe(target: Element) {
    this.targets.add(target);
  }
  unobserve(target: Element) {
    this.targets.delete(target);
  }
  disconnect() {
    this.targets.clear();
    ScrollObserver.active.delete(this);
  }
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
  intersect(isIntersecting = true) {
    this.callback(
      [...this.targets].map((target) => ({
        target,
        isIntersecting,
        intersectionRatio: isIntersecting ? 1 : 0,
        boundingClientRect: target.getBoundingClientRect(),
        intersectionRect: target.getBoundingClientRect(),
        rootBounds: null,
        time: 0,
      })),
      this,
    );
  }
}

let originalFetch: typeof fetch;
let originalWebSocket: typeof WebSocket;
let originalObserver: typeof IntersectionObserver;
let respond: (url: string) => Promise<Response>;
const requests: string[] = [];
/** The signal each request was sent with, by position in `requests`. */
const signals: (AbortSignal | undefined)[] = [];
const clients: QueryClient[] = [];

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost:3010" });
  originalFetch = globalThis.fetch;
  originalWebSocket = globalThis.WebSocket;
  originalObserver = globalThis.IntersectionObserver;
  globalThis.WebSocket = OfflineWebSocket;
  globalThis.IntersectionObserver = ScrollObserver;
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(String(input));
      signals.push(init?.signal ?? undefined);
      return respond(String(input));
    },
    { preconnect: originalFetch.preconnect },
  );
});
beforeEach(() => {
  requests.length = 0;
  signals.length = 0;
  respond = async () => {
    throw new Error("Unexpected request");
  };
});
afterEach(() => {
  cleanup();
  for (const client of clients) client.clear();
  clients.length = 0;
  expect(ScrollObserver.active.size).toBe(0);
});
afterAll(() => {
  globalThis.fetch = originalFetch;
  globalThis.WebSocket = originalWebSocket;
  globalThis.IntersectionObserver = originalObserver;
  GlobalRegistrator.unregister();
});

function channel(id: string): ChannelSummary {
  return {
    id,
    name: id,
    agentIds: [],
    threadId: id,
    active: true,
    lastMessageAt: null,
    summary: null,
    lastMessage: null,
    lastMessageAgentId: null,
    createdAt: "2026-09-15T00:00:00Z",
    pinned: false,
    lastReadAt: null,
  };
}

function renderSidebar() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  clients.push(queryClient);
  queryClient.setQueryData(userPreferencesQueryOptions("user").queryKey, {
    messageListEmphasis: "thread",
    selfHostBannerDismissed: false,
    narration: null,
    skin: "openbot",
    proactive: "on",
  });
  queryClient.setQueryData(authKeys.currentUser(), {
    id: "user",
    email: "user@example.com",
    role: "user",
    onboarding: null,
  });
  queryClient.setQueryData(agentKeys.list(false), []);
  // Read once per page load in the app; the navigation entries depend on the edition.
  queryClient.setQueryData(deploymentKeys.capabilities(), {
    generativeUi: true,
    selfHostBanner: false,
    localEvaluation: false,
    edition: "team",
  });
  // The sidebar's attention list polls on its own schedule; this test counts channel requests only.
  queryClient.setQueryDefaults(botLifecycleKeys.attention, {
    staleTime: Number.POSITIVE_INFINITY,
    refetchInterval: false,
  });
  queryClient.setQueryData(botLifecycleKeys.attention, {
    bots: [],
    lastPingId: null,
  });
  // The Bots badge reads the person's check-ins for its dot; answered here so only channel requests are counted.
  queryClient.setQueryDefaults(proactiveKeys.settings, {
    staleTime: Number.POSITIVE_INFINITY,
    refetchInterval: false,
  });
  queryClient.setQueryData(proactiveKeys.settings, {
    settings: [],
    allowed: true,
  });
  // The Browser button reads whether there is a browser once; answered here so only channel requests are counted.
  queryClient.setQueryData(browserKeys.state, {
    available: false,
    computerId: "",
    open: false,
    tabs: [],
  });
  queryClient.setQueryData(channelKeys.list(), {
    pages: [
      { channels: [channel("Recent conversation")], nextCursor: "older/page" },
    ],
    pageParams: [""],
  });
  const routeTree = createRootRoute({
    component: () => (
      <SidebarProvider>
        <AppSidebar />
      </SidebarProvider>
    ),
  });
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

function activeObserver() {
  const observer = [...ScrollObserver.active][0];
  if (!observer) throw new Error("No active pagination observer");
  return observer;
}

test("message emphasis updates mounted rows from the account preferences cache", async () => {
  const view = renderSidebar();
  const agent = await view.findByText("Recent conversation");
  const thread = view.getByText("New conversation");
  expect(thread.className).toContain("text-sm");
  act(() =>
    clients[0]?.setQueryData(userPreferencesQueryOptions("user").queryKey, {
      messageListEmphasis: "agent",
      selfHostBannerDismissed: false,
      narration: null,
      skin: "openbot",
      proactive: "on",
    }),
  );
  await waitFor(() => expect(agent.className).toContain("text-sm"));
  expect(thread.className).toContain("text-muted-foreground");
});

test("scrolling requests the cursor once, appends older rows, and stops at the final page", async () => {
  const pending = Promise.withResolvers<Response>();
  respond = () => pending.promise;
  const view = renderSidebar();
  expect(await view.findByText("Recent conversation")).toBeTruthy();
  expect(
    view.getByRole("button", { name: "Load older conversations" }),
  ).toBeTruthy();
  await waitFor(() => expect(ScrollObserver.active.size).toBe(1));
  const observer = activeObserver();
  expect(observer.root).toBe(
    view.container.querySelector('[data-sidebar="content"]'),
  );
  act(() => observer.intersect(false));
  expect(requests).toEqual([]);
  act(() => {
    observer.intersect();
    observer.intersect();
  });
  await view.findByRole("button", { name: "Loading older conversations…" });
  expect(requests).toEqual(["/api/channels?cursor=older%2Fpage"]);
  pending.resolve(
    Response.json({
      channels: [channel("Older conversation")],
      nextCursor: null,
    }),
  );
  expect(await view.findByText("Older conversation")).toBeTruthy();
  expect(view.getByText("Recent conversation")).toBeTruthy();
  expect(
    view.queryByRole("button", { name: "Load older conversations" }),
  ).toBeNull();
  expect(ScrollObserver.active.size).toBe(0);
});

test("a failed page preserves rows and waits for an explicit retry", async () => {
  respond = async () =>
    Response.json({ error: "Unavailable" }, { status: 503 });
  const view = renderSidebar();
  await view.findByText("Recent conversation");
  await waitFor(() => expect(ScrollObserver.active.size).toBe(1));
  act(() => activeObserver().intersect());
  expect(await view.findByRole("alert")).toHaveProperty(
    "textContent",
    "Couldn't load older conversations.",
  );
  expect(view.getByText("Recent conversation")).toBeTruthy();
  expect(ScrollObserver.active.size).toBe(0);
  expect(requests).toHaveLength(1);
  respond = async () =>
    Response.json({
      channels: [channel("Recovered conversation")],
      nextCursor: "last-page",
    });
  fireEvent.click(view.getByRole("button", { name: "Try again" }));
  expect(await view.findByText("Recovered conversation")).toBeTruthy();
  expect(requests).toEqual([
    "/api/channels?cursor=older%2Fpage",
    "/api/channels?cursor=older%2Fpage",
  ]);
  await waitFor(() => expect(ScrollObserver.active.size).toBe(1));
  respond = async () =>
    Response.json({
      channels: [channel("Oldest conversation")],
      nextCursor: null,
    });
  act(() => activeObserver().intersect());
  expect(await view.findByText("Oldest conversation")).toBeTruthy();
  expect(requests.at(-1)).toBe("/api/channels?cursor=last-page");
});

/** The request a sidebar search makes: the server's search, never the roster's pages. */
function searchUrl(q: string, cursor?: string) {
  const params = new URLSearchParams({ q, limit: "20" });
  if (cursor) params.set("cursor", cursor);
  return `/api/channels/search?${params}`;
}

function results(names: string[], nextCursor: string | null = null) {
  return Response.json({ channels: names.map(channel), nextCursor });
}

function searchBox(view: ReturnType<typeof renderSidebar>) {
  return view.getByRole("textbox", { name: "Search conversations" });
}

test("two characters search the whole history on the server and page its results, never the roster", async () => {
  respond = async (url) =>
    url.includes("cursor=")
      ? results(["Older archived match"])
      : results(["Archived conversation"], "search/next");
  const view = renderSidebar();
  const user = userEvent.setup({ document: view.container.ownerDocument });
  await view.findByText("Recent conversation");
  await user.type(searchBox(view), "Archived");

  expect(await view.findByText("Archived conversation")).toBeTruthy();
  expect(
    view.getByText("Search conversation names and recent messages"),
  ).toBeTruthy();
  // The roster is not what is on screen, and nothing pages it looking for a match.
  expect(view.queryByText("Recent conversation")).toBeNull();
  expect(
    view.queryByRole("button", { name: "Load older conversations" }),
  ).toBeNull();
  expect(ScrollObserver.active.size).toBe(0);
  // One request for the pause in typing, not one per keystroke.
  expect(requests).toEqual([searchUrl("Archived")]);

  fireEvent.click(view.getByRole("button", { name: "Load more results" }));
  expect(await view.findByText("Older archived match")).toBeTruthy();
  expect(view.getByText("Archived conversation")).toBeTruthy();
  expect(requests).toEqual([
    searchUrl("Archived"),
    searchUrl("Archived", "search/next"),
  ]);
  expect(view.queryByRole("button", { name: "Load more results" })).toBeNull();
  expect(requests.some((url) => url.startsWith("/api/channels?"))).toBe(false);
});

test("one character asks for another instead of searching", async () => {
  const view = renderSidebar();
  const user = userEvent.setup({ document: view.container.ownerDocument });
  await view.findByText("Recent conversation");
  await user.type(searchBox(view), " A ");

  expect(
    await view.findByText("Type at least 2 characters to search history"),
  ).toBeTruthy();
  await new Promise((resolve) => setTimeout(resolve, 400));
  expect(requests).toEqual([]);
  expect(view.queryByText("Searching…")).toBeNull();
  expect(view.queryByText("No conversations match your search")).toBeNull();
});

test("a search on its way says so, and only an answer says nothing matched", async () => {
  const pending = Promise.withResolvers<Response>();
  respond = () => pending.promise;
  const view = renderSidebar();
  const user = userEvent.setup({ document: view.container.ownerDocument });
  await view.findByText("Recent conversation");
  await user.type(searchBox(view), "zz");

  expect(await view.findByText("Searching…")).toBeTruthy();
  await waitFor(() => expect(requests).toEqual([searchUrl("zz")]));
  expect(view.getByText("Searching…")).toBeTruthy();
  expect(view.queryByText("No conversations match your search")).toBeNull();

  pending.resolve(results([]));
  expect(
    await view.findByText("No conversations match your search"),
  ).toBeTruthy();
  expect(view.queryByText("Searching…")).toBeNull();
});

test("a failed search says so with Retry, never as no matches", async () => {
  respond = async () =>
    Response.json({ error: "Search is unavailable." }, { status: 503 });
  const view = renderSidebar();
  const user = userEvent.setup({ document: view.container.ownerDocument });
  await view.findByText("Recent conversation");
  await user.type(searchBox(view), "zz");

  expect(await view.findByRole("alert")).toHaveProperty(
    "textContent",
    "Search is unavailable.",
  );
  expect(view.queryByText("No conversations match your search")).toBeNull();

  respond = async () => results(["Recovered match"], "more");
  fireEvent.click(view.getByRole("button", { name: "Retry" }));
  expect(await view.findByText("Recovered match")).toBeTruthy();
  expect(requests).toEqual([searchUrl("zz"), searchUrl("zz")]);

  // A later page that fails keeps the results already found.
  respond = async () =>
    Response.json({ error: "Search is unavailable." }, { status: 503 });
  fireEvent.click(view.getByRole("button", { name: "Load more results" }));
  expect(await view.findByRole("alert")).toHaveProperty(
    "textContent",
    "Couldn't load more results.",
  );
  expect(view.getByText("Recovered match")).toBeTruthy();
  respond = async () => results(["Last match"]);
  fireEvent.click(view.getByRole("button", { name: "Retry" }));
  expect(await view.findByText("Last match")).toBeTruthy();
  expect(requests.at(-1)).toBe(searchUrl("zz", "more"));
});

test("a slow answer to an earlier search is abandoned and never replaces the current one", async () => {
  const slow = Promise.withResolvers<Response>();
  respond = async (url) =>
    url === searchUrl("ab") ? slow.promise : results(["Current match"]);
  const view = renderSidebar();
  const user = userEvent.setup({ document: view.container.ownerDocument });
  await view.findByText("Recent conversation");
  await user.type(searchBox(view), "ab");
  await waitFor(() => expect(requests).toEqual([searchUrl("ab")]));

  await user.type(searchBox(view), "c");
  expect(await view.findByText("Current match")).toBeTruthy();
  expect(requests).toEqual([searchUrl("ab"), searchUrl("abc")]);
  expect(signals[0]?.aborted).toBe(true);

  slow.resolve(results(["Stale match"]));
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(view.queryByText("Stale match")).toBeNull();
  expect(view.getByText("Current match")).toBeTruthy();
});

test("clearing the search puts back the loaded history where it was scrolled, paging as before", async () => {
  respond = async () => results(["Archived conversation"]);
  const view = renderSidebar();
  const user = userEvent.setup({ document: view.container.ownerDocument });
  await view.findByText("Recent conversation");
  const root = view.container.querySelector(
    '[data-sidebar="content"]',
  ) as HTMLElement;
  root.scrollTop = 120;

  await user.type(searchBox(view), "Archived");
  expect(await view.findByText("Archived conversation")).toBeTruthy();
  root.scrollTop = 0;

  await user.click(searchBox(view));
  await user.keyboard("{Control>}a{/Control}{Backspace}");
  expect(await view.findByText("Recent conversation")).toBeTruthy();
  expect(view.queryByText("Archived conversation")).toBeNull();
  expect(root.scrollTop).toBe(120);
  expect(
    view.queryByText("Search conversation names and recent messages"),
  ).toBeNull();

  // The roster's own paging is back, from the cursor it had.
  await waitFor(() => expect(ScrollObserver.active.size).toBe(1));
  respond = async () =>
    Response.json({
      channels: [channel("Older conversation")],
      nextCursor: null,
    });
  act(() => activeObserver().intersect());
  expect(await view.findByText("Older conversation")).toBeTruthy();
  expect(requests).toEqual([
    searchUrl("Archived"),
    "/api/channels?cursor=older%2Fpage",
  ]);
});
