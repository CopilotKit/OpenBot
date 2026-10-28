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
import { SidebarProvider } from "@/components/ui/sidebar";
import { agentKeys } from "@/lib/agents/queries";
import { authKeys } from "@/lib/auth/queries";
import { botLifecycleKeys } from "@/lib/bot-lifecycle/queries";
import { type ChannelSummary, channelKeys } from "@/lib/channels/queries";
import { userPreferencesQueryOptions } from "@/lib/settings/message-list";
import { settleReactWork } from "./settle-react-work";

/*
 * Pin and Delete on a sidebar row. They used to be on right-click alone, which nobody finds without
 * being told and no keyboard reaches. Each row now has a "…" button beside it that opens the same
 * two: it shows when the pointer is over the row or focus is in it, and it comes straight after the
 * row in tab order.
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
  GlobalRegistrator.register({ url: "http://localhost/" });
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
  globalThis.WebSocket = originalWebSocket;
  GlobalRegistrator.unregister();
});

function conversation(
  id: string,
  summary: string,
  pinned = false,
): ChannelSummary {
  return {
    id,
    name: "Expenses",
    agentIds: ["expenses"],
    threadId: `thread-${id}`,
    active: true,
    lastMessageAt: null,
    summary,
    lastMessage: null,
    lastMessageAgentId: null,
    createdAt: "2026-10-01T00:00:00.000Z",
    pinned,
    lastReadAt: null,
  };
}

const requests: string[] = [];
let served: ChannelSummary[] = [];
beforeEach(() => {
  requests.length = 0;
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const url = String(input);
      requests.push(`${method} ${url}`);
      if (method !== "GET") return new Response(null, { status: 204 });
      if (url === "/api/channels")
        return Response.json({ channels: served, nextCursor: null });
      return Response.json({ error: "not served" }, { status: 404 });
    },
    { preconnect: originalFetch.preconnect },
  );
});

function renderSidebar(channels: ChannelSummary[]) {
  served = channels;
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  clients.push(queryClient);
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
    narration: null,
    skin: "openbot",
  });
  queryClient.setQueryData(agentKeys.list(false), []);
  queryClient.setQueryDefaults(botLifecycleKeys.attention, {
    staleTime: Number.POSITIVE_INFINITY,
    refetchInterval: false,
  });
  queryClient.setQueryData(botLifecycleKeys.attention, []);
  queryClient.setQueryData(channelKeys.list(), {
    pages: [{ channels, nextCursor: null }],
    pageParams: [""],
  });
  const router = createRouter({
    routeTree: createRootRoute({
      component: () => (
        <SidebarProvider>
          <AppSidebar />
        </SidebarProvider>
      ),
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

/**
 * What has focus, by its label, its address or its words. A string because a failed `toBe` between
 * two elements prints both of them whole, which takes bun seconds on every retry inside `waitFor`.
 */
function focused() {
  const element = document.activeElement;
  return (
    element?.getAttribute("aria-label") ??
    element?.getAttribute("href") ??
    element?.textContent ??
    null
  );
}

/** A conversation's row in the roster: the link to it, and the "…" button that belongs to it. */
async function row(view: ReturnType<typeof render>, summary: string) {
  const link = await view.findByRole("link", { name: new RegExp(summary) });
  const item = link.closest<HTMLElement>('[data-sidebar="menu-item"]');
  if (!item) throw new Error(`The row for "${summary}" is not a menu item`);
  return {
    link,
    more: within(item).getByRole("button", { name: `Options for ${summary}` }),
  };
}

test("each row's … button opens Pin and Delete, and pinning asks for it", async () => {
  const { view, user } = renderSidebar([
    conversation("c1", "Trip to Lisbon"),
    conversation("c2", "Quarterly receipts"),
  ]);
  const { more } = await row(view, "Trip to Lisbon");

  await user.click(more);
  const menu = await view.findByRole("menu");
  expect(
    within(menu)
      .getAllByRole("menuitem")
      .map((item) => item.textContent),
  ).toEqual(["Pin conversation", "Delete conversation…"]);

  await user.click(within(menu).getByRole("menuitem", { name: /^Pin/ }));
  await waitFor(() => expect(requests).toContain("PUT /api/channels/c1/pin"));
  // Only the row it was opened on.
  expect(requests).not.toContain("PUT /api/channels/c2/pin");
});

test("a pinned conversation's … menu offers Unpin", async () => {
  const { view, user } = renderSidebar([
    conversation("c1", "Trip to Lisbon", true),
  ]);
  const { more } = await row(view, "Trip to Lisbon");

  await user.click(more);

  expect(
    await view.findByRole("menuitem", { name: /Unpin conversation/ }),
  ).toBeTruthy();
});

test("the … button comes right after its row in tab order, and the keyboard can pin from it", async () => {
  const { view, user } = renderSidebar([
    conversation("c1", "Trip to Lisbon"),
    conversation("c2", "Quarterly receipts"),
  ]);
  const first = await row(view, "Trip to Lisbon");
  const second = await row(view, "Quarterly receipts");

  first.link.focus();
  expect(focused()).toBe("/channel/c1");
  await user.tab();
  expect(focused()).toBe(first.more.getAttribute("aria-label"));
  await user.tab();
  expect(focused()).toBe(second.link.getAttribute("href"));

  await user.tab({ shift: true });
  await user.keyboard("{Enter}");
  await view.findByRole("menuitem", { name: /^Pin/ });
  await waitFor(() => expect(focused()).toBe("Pin conversation"));
  await user.keyboard("{Enter}");

  await waitFor(() => expect(requests).toContain("PUT /api/channels/c1/pin"));
});

test("Delete from the … menu is confirmed before anything is deleted", async () => {
  const { view, user } = renderSidebar([conversation("c1", "Trip to Lisbon")]);
  const { more } = await row(view, "Trip to Lisbon");

  await user.click(more);
  await user.click(
    await view.findByRole("menuitem", { name: /Delete conversation/ }),
  );

  const dialog = await view.findByRole("dialog");
  expect(dialog.textContent).toContain("Expenses");
  expect(requests.some((request) => request.startsWith("DELETE"))).toBe(false);

  await user.click(within(dialog).getByRole("button", { name: "Delete" }));
  await waitFor(() => expect(requests).toContain("DELETE /api/channels/c1"));
});
