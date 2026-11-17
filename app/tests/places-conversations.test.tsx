import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
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
import type { ReactNode } from "react";
import { AppSidebar } from "@/components/app-sidebar/app-sidebar";
import {
  ConversationsBadge,
  conversationsPlace,
} from "@/components/places/conversations-place";
import { SidebarProvider } from "@/components/ui/sidebar";
import { agentKeys } from "@/lib/agents/queries";
import { authKeys } from "@/lib/auth/queries";
import { botLifecycleKeys } from "@/lib/bot-lifecycle/queries";
import { type ChannelSummary, channelKeys } from "@/lib/channels/queries";
import { deploymentKeys } from "@/lib/deployment/queries";
import { relativeTimeShort } from "@/lib/relative-time";
import {
  type MessageListEmphasis,
  userPreferencesQueryOptions,
} from "@/lib/settings/message-list";
import { settleReactWork } from "./settle-react-work";

/*
 * The Conversations place: each conversation is one line, pinned ones sit under a Pinned heading,
 * focusing a row shows a card, and the strip button carries a dot while something is unread. The
 * old sidebar keeps its two-line rows.
 */

const ConversationsPlace = conversationsPlace?.List as NonNullable<
  typeof conversationsPlace
>["List"];

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
  GlobalRegistrator.register({
    url: "http://localhost/",
    width: 1280,
    height: 840,
  });
  globalThis.WebSocket = OfflineWebSocket as unknown as typeof WebSocket;
});
afterEach(() => {
  cleanup();
  for (const client of clients) client.clear();
  clients.length = 0;
  globalThis.fetch = originalFetch;
});
afterAll(async () => {
  await settleReactWork();
  globalThis.fetch = originalFetch;
  globalThis.WebSocket = originalWebSocket;
  GlobalRegistrator.unregister();
});

const LAST_MESSAGE_AT = "2026-11-08T14:00:00Z";

function conversation(
  id: string,
  summary: string,
  overrides: Partial<ChannelSummary> = {},
): ChannelSummary {
  return {
    id,
    name: "Personal Assistant",
    agentIds: ["assistant"],
    threadId: id,
    active: true,
    lastMessageAt: LAST_MESSAGE_AT,
    summary,
    lastMessage: null,
    lastMessageAgentId: null,
    createdAt: "2026-11-08T13:00:00Z",
    pinned: false,
    lastReadAt: LAST_MESSAGE_AT,
    ...overrides,
  };
}

function seed(
  channels: ChannelSummary[],
  emphasis: MessageListEmphasis = "thread",
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  clients.push(queryClient);
  queryClient.setQueryData(deploymentKeys.capabilities(), {
    generativeUi: true,
    selfHostBanner: false,
    localEvaluation: true,
    edition: "personal",
  });
  queryClient.setQueryData(authKeys.currentUser(), {
    id: "dana",
    name: "Dana Fresh",
    email: "dana@example.com",
    role: "admin",
    onboarding: null,
  });
  queryClient.setQueryData(userPreferencesQueryOptions("dana").queryKey, {
    messageListEmphasis: emphasis,
    selfHostBannerDismissed: true,
    narration: null,
    skin: "openbot",
    proactive: "on",
  });
  queryClient.setQueryData(agentKeys.list(false), [
    {
      id: "assistant",
      name: "Assistant Bot",
      avatarSeed: "assistant",
      hidden: false,
    },
  ]);
  queryClient.setQueryData(agentKeys.list(true), []);
  queryClient.setQueryDefaults(botLifecycleKeys.attention, {
    staleTime: Number.POSITIVE_INFINITY,
    refetchInterval: false,
  });
  queryClient.setQueryData(botLifecycleKeys.attention, {
    bots: [],
    lastPingId: null,
  });
  queryClient.setQueryData(channelKeys.list(), {
    pages: [{ channels, nextCursor: null }],
    pageParams: [""],
  });
  return queryClient;
}

function renderInRouter(queryClient: QueryClient, component: () => ReactNode) {
  const router = createRouter({
    routeTree: createRootRoute({ component }),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

function renderPlace(
  channels: ChannelSummary[],
  emphasis: MessageListEmphasis = "thread",
) {
  return renderInRouter(seed(channels, emphasis), () => (
    <ConversationsPlace scrollRoot={{ current: null }} />
  ));
}

test("pinned conversations are under Pinned", async () => {
  const view = renderPlace([
    conversation("loose", "Loose chat"),
    conversation("starred", "Starred chat", { pinned: true }),
  ]);
  const heading = await view.findByRole("heading", { name: "Pinned" });
  const pinnedRow = view.getByText("Starred chat").closest("a") as HTMLElement;
  const looseRow = view.getByText("Loose chat").closest("a") as HTMLElement;
  expect(
    heading.compareDocumentPosition(pinnedRow) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(
    pinnedRow.compareDocumentPosition(looseRow) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  // Nothing is drawn between the pinned row and the one after it, and nothing else is a heading.
  expect(view.getAllByRole("heading")).toHaveLength(1);
});

test("a dense row is one line", async () => {
  const view = renderPlace([conversation("one", "Plan the launch")]);
  const row = (await view.findByText("Plan the launch")).closest(
    "a",
  ) as HTMLElement;
  expect(row.textContent).not.toContain(relativeTimeShort(LAST_MESSAGE_AT));
  expect(row.textContent).not.toContain("Personal Assistant");
  expect(row.textContent).toBe("Plan the launch");
});

test("focusing a row shows a card with its last message and its Bots", async () => {
  const view = renderPlace([
    conversation("one", "Plan the launch", {
      lastMessage: "Here is the draft schedule",
    }),
  ]);
  const row = (await view.findByText("Plan the launch")).closest(
    "a",
  ) as HTMLElement;
  expect(view.queryByText("Here is the draft schedule")).toBeNull();
  await act(async () => {
    fireEvent.focus(row);
  });
  await view.findByText("Here is the draft schedule");
  expect(view.getByText("Assistant Bot")).toBeTruthy();
});

test("the dot shows while a conversation is unread and goes when it is read", async () => {
  const queryClient = seed([
    conversation("one", "Plan the launch", {
      lastMessageAgentId: "assistant",
      lastReadAt: "2026-11-08T13:00:00Z",
    }),
  ]);
  const view = renderInRouter(queryClient, () => <ConversationsBadge />);
  await view.findByText("", { selector: '[data-slot="strip-badge"]' });
  expect(
    view.container.querySelector('[data-slot="strip-badge"]'),
  ).toBeTruthy();

  await act(async () => {
    queryClient.setQueryData(channelKeys.list(), {
      pages: [
        {
          channels: [
            conversation("one", "Plan the launch", {
              lastMessageAgentId: "assistant",
              lastReadAt: "2026-11-08T14:30:00Z",
            }),
          ],
          nextCursor: null,
        },
      ],
      pageParams: [""],
    });
  });
  await waitFor(() =>
    expect(
      view.container.querySelector('[data-slot="strip-badge"]'),
    ).toBeNull(),
  );
});

test("the old sidebar's rows still show two lines", async () => {
  const queryClient = seed([conversation("one", "Plan the launch")], "thread");
  const view = renderInRouter(queryClient, () => (
    <SidebarProvider>
      <AppSidebar />
    </SidebarProvider>
  ));
  const row = (await view.findByText("Plan the launch")).closest(
    "a",
  ) as HTMLElement;
  expect(row.textContent).toContain("Personal Assistant");
  expect(row.textContent).toContain("Plan the launch");
  expect(row.textContent).toContain(relativeTimeShort(LAST_MESSAGE_AT));
});
