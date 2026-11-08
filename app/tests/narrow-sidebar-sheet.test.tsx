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
import { TeamFeaturesDialog } from "@/components/edition/team-features-dialog";
import { SidebarToggle } from "@/components/layout/sidebar-toggle";
import { SidebarProvider } from "@/components/ui/sidebar";
import { agentKeys } from "@/lib/agents/queries";
import { authKeys } from "@/lib/auth/queries";
import { botLifecycleKeys } from "@/lib/bot-lifecycle/queries";
import { browserKeys } from "@/lib/browser/queries";
import { type ChannelSummary, channelKeys } from "@/lib/channels/queries";
import { deploymentKeys } from "@/lib/deployment/queries";
import { userPreferencesQueryOptions } from "@/lib/settings/message-list";
import { settleReactWork } from "./settle-react-work";

/*
 * In a narrow window (under 768px) the sidebar is a sheet over the page. Picking a conversation in
 * it opened that conversation behind the sheet, and the sheet stayed open until the person clicked
 * outside it, so it looked as if nothing had happened. Every way out of the sheet to a page closes
 * it; typing in its search box and opening its menus does not.
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
  // The width of the Windows window this was found in.
  GlobalRegistrator.register({
    url: "http://localhost/",
    width: 520,
    height: 840,
  });
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

function renderNarrowApp(start = "/channel/models") {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  clients.push(queryClient);
  // The personal edition, as on the Windows install: OpenBot for Business sits in the account menu.
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
  // OpenBot can run a browser here, so Teach a Bot is in the sidebar.
  queryClient.setQueryDefaults(browserKeys.state, { refetchInterval: false });
  queryClient.setQueryData(browserKeys.state, {
    available: true,
    computerId: "",
    open: false,
    tabs: [],
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
  const router = createRouter({
    routeTree: createRootRoute({
      component: () => (
        <SidebarProvider>
          <AppSidebar />
          {/* The page's own Show sidebar button, which is how a narrow window opens the sheet. */}
          <SidebarToggle />
          <TeamFeaturesDialog />
        </SidebarProvider>
      ),
    }),
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
    /** Opens the sheet as a person does, and answers with it. */
    async openSheet() {
      await user.click(
        await view.findByRole("button", { name: "Show sidebar" }),
      );
      return view.findByRole("dialog", { name: "Sidebar" });
    },
    async sheetCloses() {
      // `hidden`, because a dialog opened over the sheet hides it from the accessibility tree
      // without closing it.
      await waitFor(() =>
        expect(
          view.queryByRole("dialog", { name: "Sidebar", hidden: true }),
        ).toBeNull(),
      );
    },
  };
}

test.each([
  ["a conversation", "link", /Hacker News Top Stories/, "/channel/hn"],
  [
    "the conversation already open",
    "link",
    /AI Model and Agent Framework/,
    "/channel/models",
  ],
  ["Bots", "link", /^Bots/, "/bots"],
  ["Connections", "link", /^Connections/, "/connections"],
  ["Teach a Bot", "link", /^Teach a Bot/, "/browser"],
  // A link drawn as a button: it still goes somewhere.
  ["New conversation", "button", /^New conversation$/, "/channel/new"],
] as const)(
  "picking %s in the narrow sheet closes it and opens the page",
  async (_label, role, name, path) => {
    const app = renderNarrowApp();
    const sheet = await app.openSheet();
    await app.user.click(await within(sheet).findByRole(role, { name }));
    await app.sheetCloses();
    expect(app.router.state.location.pathname).toBe(path);
  },
);

test("Settings in the account menu closes the sheet and opens Settings", async () => {
  const app = renderNarrowApp();
  const sheet = await app.openSheet();
  await app.user.click(
    within(sheet).getByRole("button", { name: /Dana Fresh/ }),
  );
  // The menu opens over the sheet; opening it leaves the sheet where it is.
  const menu = await app.view.findByRole("menu");
  expect(app.view.getByRole("dialog", { name: "Sidebar" })).toBeTruthy();
  await app.user.click(
    within(menu).getByRole("menuitem", { name: "Settings" }),
  );
  await app.sheetCloses();
  expect(app.router.state.location.pathname).toBe("/settings");
});

test("OpenBot for Business in the account menu closes the sheet and opens its dialog", async () => {
  const app = renderNarrowApp();
  const sheet = await app.openSheet();
  await app.user.click(
    within(sheet).getByRole("button", { name: /Dana Fresh/ }),
  );
  const menu = await app.view.findByRole("menu");
  await app.user.click(
    within(menu).getByRole("menuitem", { name: "OpenBot for Business" }),
  );
  await app.sheetCloses();
  await app.view.findByRole("dialog", { name: "OpenBot for Business" });
  expect(app.router.state.location.pathname).toBe("/channel/models");
});

test("searching the sheet keeps it open", async () => {
  const app = renderNarrowApp();
  const sheet = await app.openSheet();
  await app.user.type(
    within(sheet).getByRole("textbox", { name: "Search conversations" }),
    "hacker",
  );
  expect(app.view.getByRole("dialog", { name: "Sidebar" })).toBeTruthy();
  expect(
    within(sheet).getByRole("textbox", { name: "Search conversations" }),
  ).toHaveProperty("value", "hacker");
  expect(app.router.state.location.pathname).toBe("/channel/models");
});
