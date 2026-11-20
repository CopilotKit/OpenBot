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
import { MessageListPreference } from "@/components/settings/message-list-preference";
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
 * a small avatar, the conversation's title and its time, with nothing about which Bot it is or what
 * was said last. Today's two lines, Bot name and title, are one choice away in Settings › Appearance,
 * and this browser remembers the choice.
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

test("a compact row is the title and its time: no Bot name drawn", () => {
  const view = compactRow();
  expect(view.getByText("Trip budget for Lisbon")).toBeTruthy();
  expect(view.getByText("2m")).toBeTruthy();
  // Said to a screen reader only: the orb is hidden from it.
  const said = view.container.querySelector("[data-slot=bot-name]");
  expect(said?.textContent).toBe("Personal Assistant, ");
  expect(said?.className).toBe("sr-only");
});

test("under its Bot in the Bots panel, a compact row does not say the Bot again", () => {
  const view = compactRow({ avatar: false });
  expect(view.container.querySelector("[data-slot=bot-name]")).toBeNull();
});

test("while its Bot works, a compact row says Working where its time goes", () => {
  const view = compactRow({ busy: true });
  expect(view.getByText("Working")).toBeTruthy();
  expect(view.queryByText("2m")).toBeNull();
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

test("the panel lists conversations compact by default, without the Bot's name drawn or the last message", async () => {
  const { view } = renderPanel();
  // Found in review: the compact row read only its title and time, with no Bot, to a screen reader.
  const row = await view.findByRole("link", {
    name: /^Personal Assistant, Trip budget for Lisbon/,
  });
  expect(
    row.querySelector("[data-slot=bot-name]")?.classList.contains("sr-only"),
  ).toBe(true);
  expect(view.queryByText("Here is the breakdown by day.")).toBeNull();
});

test("the panel has no view switch of its own: it lives in Settings", async () => {
  const { view } = renderPanel();
  await view.findByRole("link", { name: /Trip budget for Lisbon/ });
  expect(view.queryByRole("button", { name: "View" })).toBeNull();
});

test("a browser that chose Detailed opens Detailed", async () => {
  window.localStorage.setItem(CONVERSATION_VIEW_STORAGE_KEY, "detailed");
  const { view } = renderPanel();
  const row = await view.findByRole("link", { name: /Trip budget for Lisbon/ });
  expect(within(row).getByText("Personal Assistant")).toBeTruthy();
});

function renderSettings() {
  const queryClient = client();
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
  const view = render(
    <QueryClientProvider client={queryClient}>
      <MessageListPreference />
    </QueryClientProvider>,
  );
  return { view, user: userEvent.setup({ document }) };
}

test("Settings offers Compact and Detailed, and only Detailed has an emphasis to choose", async () => {
  const { view, user } = renderSettings();
  const list = await view.findByRole("combobox", { name: "Conversation list" });
  expect(list.textContent).toContain("Compact");
  // Emphasis picks which of two lines stands out; a compact row has one.
  expect(view.queryByRole("combobox", { name: "Message list emphasis" })).toBe(
    null,
  );

  await user.click(list);
  await user.click(await view.findByRole("option", { name: "Detailed" }));
  await waitFor(() =>
    expect(window.localStorage.getItem(CONVERSATION_VIEW_STORAGE_KEY)).toBe(
      "detailed",
    ),
  );
  expect(
    await view.findByRole("combobox", { name: "Message list emphasis" }),
  ).toBeTruthy();
});
