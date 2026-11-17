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
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { act, cleanup, render, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TeamFeaturesDialog } from "@/components/edition/team-features-dialog";
import { SidebarToggle } from "@/components/layout/sidebar-toggle";
import { PLACE_LISTS } from "@/components/places/place-panel";
import { PlacesSidebar } from "@/components/places/places-sidebar";
import { SidebarProvider } from "@/components/ui/sidebar";
import { agentKeys } from "@/lib/agents/queries";
import { authKeys } from "@/lib/auth/queries";
import { botLifecycleKeys } from "@/lib/bot-lifecycle/queries";
import { type ChannelSummary, channelKeys } from "@/lib/channels/queries";
import { deploymentKeys } from "@/lib/deployment/queries";
import { isNavigationLink, navigationFor } from "@/lib/navigation";
import { PLACES } from "@/lib/places/places";
import { getPlace, getPlaceOrder, setPlace } from "@/lib/places/store";
import { userPreferencesQueryOptions } from "@/lib/settings/message-list";
import { attentionOf } from "./bots-api";
import { awayFromOpenBot } from "./desktop-notifications.fixture";
import { settleReactWork } from "./settle-react-work";

/*
 * The places sidebar: a strip of places down its left edge and the chosen place's list beside it.
 * Choosing a place changes the list and never the page; opening a page that belongs to a place
 * chooses it. Every destination stays reachable, from the strip, its More menu or the account menu.
 */

class OfflineWebSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readyState = 0;
  onclose = null;
  onerror = null;
  onmessage = null;
  onopen = null;
  close() {}
  send() {}
}

type Viewport = { setViewport(size: { width: number; height: number }): void };
const viewport = () =>
  (globalThis as unknown as { happyDOM: Viewport }).happyDOM;

const originalFetch = globalThis.fetch;
const originalWebSocket = globalThis.WebSocket;
const originalNotification = globalThis.Notification;
const clients: QueryClient[] = [];

beforeAll(() => {
  GlobalRegistrator.register({
    url: "http://localhost/",
    width: 1280,
    height: 840,
    // The business dialog's booking calendar keeps its address but never fetches it.
    settings: { navigation: { disableChildFrameNavigation: true } },
  });
  globalThis.WebSocket = OfflineWebSocket as unknown as typeof WebSocket;
});
beforeEach(() => {
  globalThis.fetch = Object.assign(
    async () => Response.json({ error: "not served" }, { status: 404 }),
    { preconnect: originalFetch.preconnect },
  );
  setPlace("conversations");
  sessionStorage.clear();
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  for (const client of clients) client.clear();
  clients.length = 0;
  globalThis.fetch = originalFetch;
  globalThis.Notification = originalNotification;
  viewport().setViewport({ width: 1280, height: 840 });
});
afterAll(async () => {
  await settleReactWork();
  globalThis.WebSocket = originalWebSocket;
  GlobalRegistrator.unregister();
});

function conversation(id: string, summary: string): ChannelSummary {
  return {
    id,
    name: "Personal Assistant",
    agentIds: ["assistant"],
    threadId: id,
    active: true,
    lastMessageAt: "2026-11-08T14:00:00Z",
    summary,
    lastMessage: null,
    lastMessageAgentId: null,
    createdAt: "2026-11-08T13:00:00Z",
    pinned: false,
    lastReadAt: "2026-11-08T14:00:00Z",
  };
}

/** Every page the strip and its menus lead to, each drawing nothing. */
const PATHS = [
  "/",
  "/bots",
  "/agents",
  "/routines",
  "/memory",
  "/skills",
  "/connections",
  "/teams",
  "/admin",
  "/settings",
  "/channel/$channelId",
];

function renderSidebar({
  start = "/",
  edition = "team",
  waiting = 0,
  bots = waiting > 0
    ? [attentionOf("expenses", "Expenses", { questions: waiting })]
    : [],
}: {
  start?: string;
  edition?: "team" | "personal";
  /** How many things wait on the person. */
  waiting?: number;
  /** What each Bot has waiting, in place of `waiting`. */
  bots?: ReturnType<typeof attentionOf>[];
} = {}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  clients.push(queryClient);
  queryClient.setQueryData(deploymentKeys.capabilities(), {
    generativeUi: true,
    selfHostBanner: false,
    localEvaluation: edition === "personal",
    edition,
  });
  queryClient.setQueryData(authKeys.currentUser(), {
    id: "maya",
    name: "Maya Chen",
    email: "maya@example.com",
    role: "admin",
    onboarding: null,
  });
  queryClient.setQueryData(userPreferencesQueryOptions("maya").queryKey, {
    messageListEmphasis: "thread",
    selfHostBannerDismissed: true,
    narration: null,
    skin: "openbot",
    proactive: "on",
  });
  queryClient.setQueryData(agentKeys.list(false), []);
  queryClient.setQueryDefaults(botLifecycleKeys.attention, {
    staleTime: Number.POSITIVE_INFINITY,
    refetchInterval: false,
  });
  queryClient.setQueryData(botLifecycleKeys.attention, {
    bots,
    lastPingId: null,
  });
  queryClient.setQueryData(channelKeys.list(), {
    pages: [
      {
        channels: [
          conversation("models", "AI Model and Agent Framework"),
          conversation("hn", "Hacker News Top Stories"),
        ],
        nextCursor: null,
      },
    ],
    pageParams: [""],
  });
  const rootRoute = createRootRoute({
    component: () => (
      <SidebarProvider>
        <PlacesSidebar />
        {/* The page's own Show sidebar button, which is how a narrow window opens the sheet. */}
        <SidebarToggle />
        {/* Mounted once by the signed-in layout; here so the entry has something to open. */}
        <TeamFeaturesDialog />
        <Outlet />
      </SidebarProvider>
    ),
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren(
      PATHS.map((path) =>
        createRoute({
          getParentRoute: () => rootRoute,
          path,
          component: () => null,
        }),
      ),
    ),
    history: createMemoryHistory({ initialEntries: [start] }),
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  const user = userEvent.setup({ document });
  return {
    view,
    user,
    router,
    queryClient,
    strip: () => view.findByRole("toolbar"),
  };
}

/**
 * The addresses in the More menu and then in the account menu, each opened in turn, and the
 * names of the strip's place buttons.
 */
async function reachable(app: ReturnType<typeof renderSidebar>) {
  const strip = await app.strip();
  const places = within(strip)
    .getAllByRole("button")
    .filter((button) => button.hasAttribute("aria-pressed"))
    .map((button) => button.getAttribute("aria-label"));
  const hrefs = (menu: HTMLElement) =>
    within(menu)
      .getAllByRole("menuitem")
      .map((item) => item.getAttribute("href"))
      .filter((href) => href !== null);

  await app.user.click(within(strip).getByRole("button", { name: "More" }));
  const more = hrefs(await app.view.findByRole("menu"));
  await app.user.keyboard("{Escape}");
  await waitFor(() => expect(app.view.queryByRole("menu")).toBeNull());

  await app.user.click(
    within(strip).getByRole("button", { name: "Maya Chen" }),
  );
  const accountMenu = await app.view.findByRole("menu");
  return {
    places,
    more,
    hrefs: [...more, ...hrefs(accountMenu)],
    accountMenu,
  };
}

/** The strip's place buttons are the five places, in the person's order, and More holds neither Bots nor Routines. */
function expectPlacesOwnBotsAndRoutines(reached: {
  places: (string | null)[];
  more: (string | null)[];
}) {
  expect(reached.places).toEqual(getPlaceOrder().map((id) => PLACES[id].label));
  expect(reached.more).not.toContain("/bots");
  expect(reached.more).not.toContain("/routines");
}

test("every destination a person may open is in the strip, More or the account menu", async () => {
  const app = renderSidebar();
  const reached = await reachable(app);
  const { places, hrefs } = reached;
  expectPlacesOwnBotsAndRoutines(reached);
  for (const item of navigationFor("admin", "team").filter(isNavigationLink)) {
    expect({
      to: item.to,
      reached: hrefs.includes(item.to) || places.includes(item.label),
    }).toEqual({ to: item.to, reached: true });
  }
});

test("the personal edition offers no Memory and no Teams, and offers the team features list", async () => {
  const app = renderSidebar({ edition: "personal" });
  const reached = await reachable(app);
  const { places, hrefs, accountMenu } = reached;
  expectPlacesOwnBotsAndRoutines(reached);
  for (const item of navigationFor("admin", "personal").filter(
    isNavigationLink,
  )) {
    expect({
      to: item.to,
      reached: hrefs.includes(item.to) || places.includes(item.label),
    }).toEqual({ to: item.to, reached: true });
  }
  expect(hrefs).not.toContain("/memory");
  expect(hrefs).not.toContain("/teams");
  expect(document.querySelector('a[href="/memory"]')).toBeNull();
  expect(document.querySelector('a[href="/teams"]')).toBeNull();
  expect(
    within(accountMenu).getByRole("menuitem", {
      name: "OpenBot for Business",
    }),
  ).toBeTruthy();
});

test("the OpenBot button's description says how many things need you", async () => {
  const app = renderSidebar({ waiting: 1 });
  const strip = await app.strip();
  const button = await within(strip).findByRole("button", {
    name: PLACES.openbot.label,
  });
  await waitFor(() => {
    const id = button.getAttribute("aria-describedby");
    expect(id).toBeTruthy();
    expect(document.getElementById(id ?? "")?.textContent).toContain(
      "1 needs you",
    );
  });
});

test("with nothing waiting, what check-ins found is a dot on the OpenBot button, said in words", async () => {
  const app = renderSidebar({
    bots: [attentionOf("expenses", "Expenses", { items: 1 })],
  });
  const strip = await app.strip();
  const button = await within(strip).findByRole("button", {
    name: PLACES.openbot.label,
  });
  await waitFor(() => {
    const id = button.getAttribute("aria-describedby");
    expect(id).toBeTruthy();
    expect(document.getElementById(id ?? "")?.textContent).toBe(
      "Your check-ins found something",
    );
  });
  expect(button.querySelector('[data-slot="strip-badge"]')).toBeTruthy();
});

test("a Bot that starts needing the person sends a browser notification", async () => {
  const sent: string[] = [];
  globalThis.Notification = Object.assign(
    function (this: unknown, title: string) {
      sent.push(title);
    },
    { permission: "granted" },
  ) as unknown as typeof Notification;
  const away = awayFromOpenBot();
  try {
    const app = renderSidebar({
      bots: [attentionOf("expenses", "Expenses")],
    });
    await app.strip();
    // The state on arrival is not news.
    await settleReactWork();
    expect(sent).toEqual([]);

    act(() =>
      app.queryClient.setQueryData(botLifecycleKeys.attention, {
        bots: [attentionOf("expenses", "Expenses", { questions: 1 })],
        lastPingId: null,
      }),
    );
    await waitFor(() => expect(sent).toEqual(["Expenses needs you"]));
  } finally {
    away.look();
  }
});

test("choosing a place changes the list and not the page", async () => {
  const app = renderSidebar({ start: "/bots" });
  const strip = await app.strip();
  await waitFor(() => expect(getPlace()).toBe("bots"));
  await app.user.click(
    within(strip).getByRole("button", { name: PLACES.conversations.label }),
  );
  expect(getPlace()).toBe("conversations");
  expect(app.router.state.location.pathname).toBe("/bots");
  expect(
    await app.view.findByRole("textbox", { name: "Search conversations" }),
  ).toBeTruthy();
});

test("opening a Bot's page selects Bots", async () => {
  const app = renderSidebar();
  await app.strip();
  expect(getPlace()).toBe("conversations");
  await act(() => app.router.history.push("/bots"));
  await waitFor(() => expect(app.router.state.location.pathname).toBe("/bots"));
  await waitFor(() => expect(getPlace()).toBe("bots"));
});

test("opening a conversation leaves the place alone", async () => {
  const app = renderSidebar();
  await app.strip();
  act(() => setPlace("conversations"));
  await act(() => app.router.history.push("/channel/c1"));
  await waitFor(() =>
    expect(app.router.state.location.pathname).toBe("/channel/c1"),
  );
  expect(getPlace()).toBe("conversations");

  act(() => setPlace("openbot"));
  await act(() => app.router.history.push("/channel/c2"));
  await waitFor(() =>
    expect(app.router.state.location.pathname).toBe("/channel/c2"),
  );
  expect(getPlace()).toBe("openbot");
});

test("in the phone's sheet a row closes it and a place does not", async () => {
  // The width of the Windows window the narrow sheet was found in.
  viewport().setViewport({ width: 520, height: 840 });
  const app = renderSidebar({ start: "/channel/models" });
  await app.user.click(
    await app.view.findByRole("button", { name: "Show sidebar" }),
  );
  const sheet = await app.view.findByRole("dialog", { name: "Sidebar" });

  await app.user.click(
    within(sheet).getByRole("button", { name: PLACES.conversations.label }),
  );
  expect(app.view.getByRole("dialog", { name: "Sidebar" })).toBeTruthy();
  expect(app.router.state.location.pathname).toBe("/channel/models");

  await app.user.click(
    await within(sheet).findByRole("link", { name: /Hacker News Top Stories/ }),
  );
  await waitFor(() =>
    expect(
      app.view.queryByRole("dialog", { name: "Sidebar", hidden: true }),
    ).toBeNull(),
  );
  expect(app.router.state.location.pathname).toBe("/channel/hn");
});

test("the strip is one tab stop", async () => {
  const app = renderSidebar();
  const strip = await app.strip();
  expect(document.activeElement).toBe(document.body);
  const first = getPlaceOrder().find((id) => PLACE_LISTS[id]);
  if (!first) throw new Error("No place has a list");

  await app.user.tab();
  expect(document.activeElement?.getAttribute("aria-label")).toBe(
    PLACES[first].label,
  );

  const before = document.activeElement;
  await app.user.keyboard("{ArrowDown}");
  expect(document.activeElement).not.toBe(before);
  expect(strip.contains(document.activeElement)).toBe(true);

  await app.user.tab();
  expect(strip.contains(document.activeElement)).toBe(false);
});
