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
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, within } from "@testing-library/react";
import { PlacePanel } from "@/components/places/place-panel";
import { SidebarProvider } from "@/components/ui/sidebar";
import { agentKeys } from "@/lib/agents/queries";
import { authKeys } from "@/lib/auth/queries";
import { botLifecycleKeys } from "@/lib/bot-lifecycle/queries";
import { type ChannelSummary, channelKeys } from "@/lib/channels/queries";
import { deploymentKeys } from "@/lib/deployment/queries";
import { PLACES } from "@/lib/places/places";
import { setPlace } from "@/lib/places/store";
import { userPreferencesQueryOptions } from "@/lib/settings/message-list";
import { settleReactWork } from "./settle-react-work";

/*
 * The panel under the strip: a header naming the place and the place's own list.
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
  GlobalRegistrator.register({
    url: "http://localhost/",
    width: 1280,
    height: 840,
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

function renderPanel() {
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
    bots: [],
    lastPingId: null,
  });
  queryClient.setQueryData(channelKeys.list(), {
    pages: [
      {
        channels: [conversation("models", "AI Model and Agent Framework")],
        nextCursor: null,
      },
    ],
    pageParams: [""],
  });
  const router = createRouter({
    routeTree: createRootRoute({
      component: () => (
        <SidebarProvider>
          <PlacePanel />
          <Outlet />
        </SidebarProvider>
      ),
    }),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

test("the header names the place", async () => {
  const view = renderPanel();
  const heading = await view.findByRole("heading", { level: 2 });
  expect(heading.textContent).toBe(PLACES.conversations.label);
  const header = heading.closest('[data-sidebar="header"]');
  expect(header).not.toBeNull();
  expect(within(header as HTMLElement).getByRole("heading", { level: 2 })).toBe(
    heading,
  );
});
