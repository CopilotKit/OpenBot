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
import { cleanup, render, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AppSidebar } from "@/components/app-sidebar/app-sidebar";
import { ChannelItemContent } from "@/components/app-sidebar/channel-item-content";
import { SidebarShell } from "@/components/layout/sidebar-shell";
import { agentKeys, agentListQueryOptions } from "@/lib/agents/queries";
import { authKeys } from "@/lib/auth/queries";
import { botLifecycleKeys } from "@/lib/bot-lifecycle/queries";
import { type ChannelSummary, channelKeys } from "@/lib/channels/queries";
import { deploymentKeys } from "@/lib/deployment/queries";
import { SectionProvider } from "@/lib/sections";
import {
  CONVERSATION_VIEW_STORAGE_KEY,
  readConversationView,
} from "@/lib/settings/conversation-view";
import { userPreferencesQueryOptions } from "@/lib/settings/message-list";
import { settleReactWork } from "./settle-react-work";

/*
 * The Conversations panel lists each conversation on one line by default, as Claude's sidebar does:
 * a small avatar and the conversation's title, with nothing about which Bot it is or what was said
 * last. Today's two lines, Bot name and title, are one choice away in the panel's View menu, and
 * this browser remembers the choice.
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

const originalFetch = globalThis.fetch;
const originalWebSocket = globalThis.WebSocket;
const clients: QueryClient[] = [];

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/", width: 1280 });
  globalThis.WebSocket = OfflineWebSocket as unknown as typeof WebSocket;
});
beforeEach(() => {
  window.localStorage.clear();
  globalThis.fetch = Object.assign(
    async () => Response.json({ error: "not served" }, { status: 404 }),
    { preconnect: originalFetch.preconnect },
  );
});
afterEach(() => {
  cleanup();
  for (const client of clients) client.clear();
  clients.length = 0;
  globalThis.fetch = originalFetch;
});
afterAll(async () => {
  await settleReactWork();
  globalThis.WebSocket = originalWebSocket;
  GlobalRegistrator.unregister();
});

function client() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  clients.push(queryClient);
  queryClient.setQueryData(agentListQueryOptions().queryKey, []);
  return queryClient;
}

function compactRow(
  props: Partial<Parameters<typeof ChannelItemContent>[0]> = {},
) {
  return render(
    <QueryClientProvider client={client()}>
      <ChannelItemContent
        emphasis="thread"
        lastMessageAt="2m"
        name="Personal Assistant"
        participantIds={["bot-1"]}
        title="Trip budget for Lisbon"
        view="compact"
        {...props}
      />
    </QueryClientProvider>,
  );
}

test("a compact row is the title alone: no Bot name and no time", () => {
  const view = compactRow();
  expect(view.getByText("Trip budget for Lisbon")).toBeTruthy();
  expect(view.queryByText("Personal Assistant")).toBeNull();
  expect(view.queryByText("2m")).toBeNull();
});

test("a compact row says nothing in words while its Bot works: its avatar shows it", () => {
  const view = compactRow({ busy: true });
  expect(view.queryByText("Working")).toBeNull();
  expect(view.getByText("Trip budget for Lisbon")).toBeTruthy();
});

test("a compact row keeps the unread dot and the pin", () => {
  const view = compactRow({ unread: true, pinned: true });
  expect(view.container.querySelector("[data-slot=unread-dot]")).not.toBeNull();
  expect(view.container.querySelector("[data-slot=pinned]")).not.toBeNull();
  const plain = compactRow({ unread: false, pinned: false });
  expect(plain.container.querySelector("[data-slot=unread-dot]")).toBeNull();
  expect(plain.container.querySelector("[data-slot=pinned]")).toBeNull();
});

test("the view this browser remembers, Compact unless Detailed was chosen", () => {
  expect(readConversationView(null)).toBe("compact");
  expect(readConversationView("detailed")).toBe("detailed");
  expect(readConversationView("compact")).toBe("compact");
  expect(readConversationView("something else")).toBe("compact");
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
    lastMessage: "Here is the breakdown by day.",
    lastMessageAgentId: null,
    createdAt: "2026-11-08T13:00:00Z",
    pinned: false,
    lastReadAt: "2026-11-08T14:00:00Z",
  };
}

function renderPanel() {
  const queryClient = client();
  queryClient.setQueryData(deploymentKeys.capabilities(), {
    generativeUi: true,
    selfHostBanner: false,
    localEvaluation: false,
    edition: "team",
  });
  queryClient.setQueryData(authKeys.currentUser(), {
    id: "maya",
    name: "Maya Chen",
    email: "maya@example.com",
    role: "user",
    onboarding: null,
  });
  queryClient.setQueryData(userPreferencesQueryOptions("maya").queryKey, {
    messageListEmphasis: "thread",
    selfHostBannerDismissed: true,
    dismissedNotices: [],
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
    bots: [],
    lastPingId: null,
  });
  queryClient.setQueryData(channelKeys.list(), {
    pages: [
      {
        channels: [conversation("c1", "Trip budget for Lisbon")],
        nextCursor: null,
      },
    ],
    pageParams: [""],
  });
  const router = createRouter({
    routeTree: createRootRoute({
      component: () => (
        <SectionProvider>
          <SidebarShell>
            <AppSidebar />
          </SidebarShell>
        </SectionProvider>
      ),
      notFoundComponent: () => null,
    }),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { view, user: userEvent.setup({ document }) };
}

test("the panel lists conversations compact by default, without the Bot's name or the last message", async () => {
  const { view } = renderPanel();
  const row = await view.findByRole("link", { name: /Trip budget for Lisbon/ });
  expect(within(row).queryByText("Personal Assistant")).toBeNull();
  expect(view.queryByText("Here is the breakdown by day.")).toBeNull();
});

test("View › Detailed brings back the Bot's name, and this browser remembers it", async () => {
  const { view, user } = renderPanel();
  await view.findByRole("link", { name: /Trip budget for Lisbon/ });
  await user.click(view.getByRole("button", { name: "View" }));
  const menu = await view.findByRole("menu");
  await user.click(
    within(menu).getByRole("menuitemradio", { name: "Detailed" }),
  );
  await waitFor(() =>
    expect(
      within(
        view.getByRole("link", { name: /Trip budget for Lisbon/ }),
      ).getByText("Personal Assistant"),
    ).toBeTruthy(),
  );
  expect(window.localStorage.getItem(CONVERSATION_VIEW_STORAGE_KEY)).toBe(
    "detailed",
  );
  // Picking a view is the menu's whole job, so picking one closes it.
  await waitFor(() => expect(view.queryByRole("menu")).toBeNull());
});

test("a browser that chose Detailed opens Detailed", async () => {
  window.localStorage.setItem(CONVERSATION_VIEW_STORAGE_KEY, "detailed");
  const { view } = renderPanel();
  const row = await view.findByRole("link", { name: /Trip budget for Lisbon/ });
  expect(within(row).getByText("Personal Assistant")).toBeTruthy();
});
