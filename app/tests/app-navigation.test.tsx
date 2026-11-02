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
import { channelKeys } from "@/lib/channels/queries";
import { NAVIGATION, navigationFor } from "@/lib/navigation";
import { userPreferencesQueryOptions } from "@/lib/settings/message-list";
import { settleReactWork } from "./settle-react-work";

/*
 * OpenBot's destinations live in one list (`lib/navigation.ts`) that the sidebar and every skin draw
 * from. This holds the sidebar to that list exactly: the same entries, in the same order, at the
 * same addresses, with Admin only for admins. A destination added to the list and not drawn, or
 * drawn here and not added to the list, fails.
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
beforeEach(() => {
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

function renderSidebar(role: "admin" | "user") {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  clients.push(queryClient);
  queryClient.setQueryData(authKeys.currentUser(), {
    id: "maya",
    name: "Maya Chen",
    email: "maya@example.com",
    role,
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
  // One question waiting, so the Bots entry carries its badge.
  queryClient.setQueryData(botLifecycleKeys.attention, [
    {
      agentId: "expenses",
      name: "Expenses",
      questions: 1,
      approvals: 0,
      handoffs: 0,
      unread: 0,
      paused: false,
      notify: "all",
    },
  ]);
  queryClient.setQueryData(channelKeys.list(), {
    pages: [{ channels: [], nextCursor: null }],
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

/** Label and address of every link in `root`, in document order. */
function links(root: HTMLElement) {
  return [...root.querySelectorAll("a[href]")].map((link) => ({
    label: link.textContent?.trim() ?? "",
    to: link.getAttribute("href"),
  }));
}

function expected(role: "admin" | "user", section: "primary" | "account") {
  return navigationFor(role)
    .filter((item) => item.section === section)
    .map((item) => ({ label: item.label, to: item.to }));
}

test.each(["user", "admin"] as const)(
  "the sidebar draws exactly the shared list for a %s",
  async (role) => {
    const { view, user } = renderSidebar(role);
    const footer = await waitFor(() => {
      const element = view.container.querySelector<HTMLElement>(
        '[data-sidebar="footer"]',
      );
      if (!element) throw new Error("No sidebar footer");
      return element;
    });
    expect(
      links(footer).map(({ label, to }) => ({
        label: label.replace(/\d+$/, ""),
        to,
      })),
    ).toEqual(expected(role, "primary"));
    // Bots keeps its count of what waits on the person, and only Bots has one.
    const badge = within(footer).getByRole("img", {
      name: "1 thing needs you",
    });
    expect(badge.closest("a")?.getAttribute("href")).toBe("/bots");

    await user.click(view.getByRole("button", { name: /Maya Chen/ }));
    const menu = await view.findByRole("menu");
    const items = within(menu)
      .getAllByRole("menuitem")
      .map((item) => item.textContent?.trim());
    expect(items).toEqual([
      ...expected(role, "account").map((item) => item.label),
      "Sign out",
    ]);
    expect(links(menu)).toEqual(expected(role, "account"));
  },
);

test("Admin is in the list for admins only", () => {
  const ids = (role: string | undefined) =>
    navigationFor(role).map((item) => item.id);
  expect(ids("admin")).toEqual(NAVIGATION.map((item) => item.id));
  expect(ids("user")).not.toContain("admin");
  expect(ids(undefined)).not.toContain("admin");
  expect(ids("user")).toEqual([
    "bots",
    "capabilities",
    "connections",
    "settings",
  ]);
});
