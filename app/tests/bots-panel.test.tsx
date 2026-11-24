import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  MutationObserver,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AppSidebar } from "@/components/app-sidebar/app-sidebar";
import { SidebarShell } from "@/components/layout/sidebar-shell";
import { type AgentProfile, agentKeys } from "@/lib/agents/queries";
import { authKeys } from "@/lib/auth/queries";
import { resetBotMutationOptions } from "@/lib/bot-lifecycle/mutations";
import { botLifecycleKeys } from "@/lib/bot-lifecycle/queries";
import { deleteChannelMutationOptions } from "@/lib/channels/mutations";
import { type ChannelSummary, channelKeys } from "@/lib/channels/queries";
import { deploymentKeys } from "@/lib/deployment/queries";
import {
  CONVERSATIONS,
  SectionProvider,
  sectionHasPanel,
  useOpenSection,
} from "@/lib/sections";
import { userPreferencesQueryOptions } from "@/lib/settings/message-list";
import {
  CONVERSATIONS_PATH,
  conversationPage,
  conversationPath,
  noContent,
  ORGANIZATION_PATH,
} from "./conversations-api";
import { settleReactWork } from "./settle-react-work";

/*
 * The Bots section's panel: every Bot, newest conversation first, the top three open with their
 * latest conversations read from the server by Bot. A caret opens and closes a Bot; its name opens
 * its page. Show more reads the next five; the search narrows Bots by name.
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
let served: Record<string, (cursor: string | null) => Response>;
/** Writes the server answers, by method and path; each may change what it lists after. */
let writes: Record<string, () => Response>;
/** What the server lists as the Bots when the app reads them again (listBots). */
let listed: AgentProfile[] | null;
const asked: string[] = [];
const BOTS_PATH = `${ORGANIZATION_PATH}/bots`;

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/", width: 1280 });
  globalThis.WebSocket = OfflineWebSocket as unknown as typeof WebSocket;
});
beforeEach(() => {
  window.localStorage.clear();
  asked.length = 0;
  served = {};
  writes = {};
  listed = null;
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://localhost/");
      const method = (init?.method ?? "GET").toUpperCase();
      const write = writes[`${method} ${url.pathname}`];
      if (write) return write();
      if (url.pathname === BOTS_PATH && listed)
        return Response.json({ bots: listed, nextCursor: null });
      if (url.pathname === CONVERSATIONS_PATH) {
        const botId = url.searchParams.get("botId");
        asked.push(botId ?? "(all)");
        const answer = served[botId ?? "(all)"];
        if (answer) return answer(url.searchParams.get("cursor"));
        return Response.json(conversationPage([]));
      }
      return Response.json({ error: "not served" }, { status: 404 });
    },
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

const bot = (id: string, name: string, lastConversationAt: string | null) =>
  ({
    id,
    name,
    title: "",
    roleDescription: "",
    avatarSeed: id,
    lastConversationAt,
  }) as unknown as AgentProfile;

function conversation(
  id: string,
  agentIds: string[],
  summary: string,
  lastMessageAt = "2026-11-01T10:00:00.000Z",
): ChannelSummary {
  return {
    id,
    name: "",
    agentIds,
    threadId: id,
    active: true,
    lastMessageAt,
    summary,
    lastMessage: null,
    lastMessageAgentId: null,
    createdAt: "2026-11-01T09:00:00.000Z",
    pinned: false,
    lastReadAt: lastMessageAt,
  } as ChannelSummary;
}

const BOTS = [
  bot("quiet", "Quiet", null),
  bot("finance", "Finance Ops", "2026-11-05T10:00:00.000Z"),
  bot("invoice", "Invoice Review", "2026-11-06T10:00:00.000Z"),
  bot("research", "Research", "2026-11-04T10:00:00.000Z"),
  bot("old", "Old Helper", "2026-10-01T10:00:00.000Z"),
];

function Frame() {
  const { section, show } = useOpenSection();
  return (
    <SidebarShell
      panel={{
        available: sectionHasPanel(section),
        reveal: () => show(CONVERSATIONS),
      }}
    >
      <AppSidebar />
    </SidebarShell>
  );
}

function renderPanel(attention: unknown[] = []) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  clients.push(queryClient);
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
  queryClient.setQueryData(agentKeys.list(false), BOTS);
  queryClient.setQueryDefaults(botLifecycleKeys.attention, {
    staleTime: Number.POSITIVE_INFINITY,
    refetchInterval: false,
  });
  queryClient.setQueryData(botLifecycleKeys.attention, {
    bots: attention,
    lastPingId: null,
  });
  queryClient.setQueryData(channelKeys.list(), {
    pages: [{ channels: [], nextCursor: null }],
    pageParams: [""],
  });
  const router = createRouter({
    routeTree: createRootRoute({
      component: () => (
        <SectionProvider>
          <Frame />
        </SectionProvider>
      ),
      notFoundComponent: () => null,
    }),
    history: createMemoryHistory({ initialEntries: ["/bots"] }),
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { view, router, queryClient, user: userEvent.setup({ document }) };
}

const botRows = (view: ReturnType<typeof render>) =>
  [
    ...view.container.querySelectorAll<HTMLElement>("[data-slot=bot-row] a"),
  ].map((link) => link.textContent?.trim());

test("Bots are listed newest conversation first, and Bots with none last", async () => {
  const { view } = renderPanel();
  await view.findByRole("heading", { level: 2, name: "Bots" });
  expect(botRows(view)).toEqual([
    "Invoice Review",
    "Finance Ops",
    "Research",
    "Old Helper",
    "Quiet",
  ]);
});

test("the top three open with their conversations, read from the server by Bot", async () => {
  served.invoice = () =>
    Response.json(
      conversationPage([conversation("i1", ["invoice"], "Open Acme invoices")]),
    );
  const { view } = renderPanel();
  expect(await view.findByText("Open Acme invoices")).toBeTruthy();
  await waitFor(() =>
    expect(new Set(asked)).toEqual(new Set(["invoice", "finance", "research"])),
  );
  const caret = (name: string) =>
    view.getByRole("button", { name: new RegExp(`${name}'s conversations`) });
  expect(caret("Invoice Review").getAttribute("aria-expanded")).toBe("true");
  expect(caret("Research").getAttribute("aria-expanded")).toBe("true");
  expect(caret("Old Helper").getAttribute("aria-expanded")).toBe("false");
});

test("a Bot's conversations under it are titles and times, without the Bot's orb again", async () => {
  served.invoice = () =>
    Response.json(
      conversationPage([conversation("i1", ["invoice"], "Open Acme invoices")]),
    );
  const { view } = renderPanel();
  const row = (await view.findByText("Open Acme invoices")).closest("a");
  expect(row?.querySelector("[role=img]")).toBeNull();
});

test("a Bot's conversations under it are named by slot, for whatever reads the panel", async () => {
  served.invoice = () =>
    Response.json(
      conversationPage([
        conversation("i1", ["invoice"], "Open Acme invoices"),
        conversation("i2", ["invoice"], "Vendor follow-up"),
      ]),
    );
  const { view } = renderPanel();
  await view.findByText("Vendor follow-up");
  const invoice = view
    .getByRole("button", { name: "Hide Invoice Review's conversations" })
    .closest("li");
  const rows = [
    ...(invoice?.querySelectorAll<HTMLElement>(
      "[data-slot=bot-conversation-row]",
    ) ?? []),
  ];
  expect(rows.map((row) => row.getAttribute("href"))).toEqual([
    "/channel/i1",
    "/channel/i2",
  ]);
});

/** What the server answers a reset with: the counts it deleted. */
const RESET = {
  validateOnly: false,
  deleted: {
    conversations: 1,
    sharedConversationsKept: 0,
    memorySources: 0,
    memories: 0,
    routines: 0,
    responsibilities: 0,
    followUps: 0,
    formedMemories: 0,
    backgroundResearch: 0,
    standingApprovals: 0,
  },
};

/** The Bots as the server lists them once Invoice Review has no conversations left. */
const withoutInvoiceConversations = () =>
  BOTS.map((each) =>
    each.id === "invoice" ? { ...each, lastConversationAt: null } : each,
  );

test("a Bot that is reset leaves the top of the panel, and its conversations go from under it", async () => {
  let reset = false;
  served.invoice = () =>
    Response.json(
      conversationPage(
        reset ? [] : [conversation("i1", ["invoice"], "Open Acme invoices")],
      ),
    );
  writes[`POST ${BOTS_PATH}/invoice/reset`] = () => {
    reset = true;
    listed = withoutInvoiceConversations();
    return Response.json(RESET);
  };
  const { view, queryClient } = renderPanel();
  await view.findByText("Open Acme invoices");
  expect(botRows(view)[0]).toBe("Invoice Review");

  await new MutationObserver(
    queryClient,
    resetBotMutationOptions(queryClient),
  ).mutate("invoice");

  await waitFor(() =>
    expect(botRows(view)).toEqual([
      "Finance Ops",
      "Research",
      "Old Helper",
      "Invoice Review",
      "Quiet",
    ]),
  );
  const invoice = view
    .getByRole("button", { name: /Invoice Review's conversations/ })
    .closest("li");
  await waitFor(() =>
    expect(invoice?.textContent).toContain(
      "No conversations with this Bot yet.",
    ),
  );
  expect(view.queryByText("Open Acme invoices")).toBeNull();
});

test("deleting a Bot's last conversation moves the Bot down the panel", async () => {
  let deleted = false;
  served.invoice = () =>
    Response.json(
      conversationPage(
        deleted ? [] : [conversation("i1", ["invoice"], "Open Acme invoices")],
      ),
    );
  writes[`DELETE ${conversationPath("i1")}`] = () => {
    deleted = true;
    listed = withoutInvoiceConversations();
    return noContent();
  };
  const { view, queryClient } = renderPanel();
  await view.findByText("Open Acme invoices");
  expect(botRows(view)[0]).toBe("Invoice Review");

  await new MutationObserver(
    queryClient,
    deleteChannelMutationOptions(queryClient),
  ).mutate("i1");

  await waitFor(() => expect(botRows(view)[0]).toBe("Finance Ops"));
  expect(botRows(view)).toContain("Invoice Review");
  expect(botRows(view).indexOf("Invoice Review")).toBe(3);
});

test("the caret opens and closes a Bot, and the Bot's name opens its page", async () => {
  served.old = () =>
    Response.json(conversationPage([conversation("o1", ["old"], "Last year")]));
  const { view, user, router } = renderPanel();
  const caret = await view.findByRole("button", {
    name: "Show Old Helper's conversations",
  });
  await user.click(caret);
  expect(await view.findByText("Last year")).toBeTruthy();
  const hide = view.getByRole("button", {
    name: "Hide Old Helper's conversations",
  });
  expect(hide.getAttribute("aria-expanded")).toBe("true");
  await user.click(hide);
  await waitFor(() => expect(view.queryByText("Last year")).toBeNull());

  await user.click(view.getByRole("link", { name: /^Old Helper/ }));
  await waitFor(() => expect(router.state.location.pathname).toBe("/bots/old"));
});

test("Show more reads the next five under the Bot, and goes when there are no more", async () => {
  const first = Array.from({ length: 5 }, (_, index) =>
    conversation(`f${index}`, ["invoice"], `First ${index}`),
  );
  served.invoice = (cursor) =>
    Response.json(
      cursor === "next"
        ? conversationPage([conversation("f5", ["invoice"], "Sixth one")])
        : conversationPage(first, "next"),
    );
  const { view, user } = renderPanel();
  await view.findByText("First 4");
  await user.click(view.getByRole("button", { name: "Show more" }));
  expect(await view.findByText("Sixth one")).toBeTruthy();
  await waitFor(() =>
    expect(view.queryByRole("button", { name: "Show more" })).toBeNull(),
  );
});

test("a Bot's conversations that fail to load say so, with Retry, never as none", async () => {
  let fail = true;
  served.invoice = () =>
    fail
      ? Response.json(
          { title: "Down", status: 500, detail: "Down" },
          { status: 500 },
        )
      : Response.json(
          conversationPage([conversation("i1", ["invoice"], "Back again")]),
        );
  const { view, user } = renderPanel();
  const retry = await view.findByRole("button", { name: "Retry" });
  const invoice = view
    .getByRole("button", { name: "Hide Invoice Review's conversations" })
    .closest("li");
  expect(invoice?.contains(retry)).toBe(true);
  expect(invoice?.textContent).not.toContain(
    "No conversations with this Bot yet.",
  );
  fail = false;
  await user.click(retry);
  expect(await view.findByText("Back again")).toBeTruthy();
});

test("the search narrows Bots by name, and says when none match", async () => {
  const { view, user } = renderPanel();
  const search = await view.findByRole("textbox", { name: "Search Bots" });
  await user.type(search, "fin");
  await waitFor(() => expect(botRows(view)).toEqual(["Finance Ops"]));
  await user.type(search, "zzz");
  expect(await view.findByText(/No Bots match/)).toBeTruthy();
});

test("a Bot with something waiting on you has a dot that says what", async () => {
  const { view } = renderPanel([
    {
      botId: "research",
      name: "Research",
      questions: 1,
      approvals: 0,
      handoffs: 0,
      unread: 0,
      paused: false,
      notify: "all",
      items: 0,
      tasks: { needsInput: 0, ready: 0, failed: 0 },
    },
  ]);
  const dot = await view.findByRole("img", { name: "1 question" });
  expect(dot.closest("[data-slot=bot-row]")?.textContent).toContain("Research");
});

test("New Bot is in the panel's header", async () => {
  const { view } = renderPanel();
  // A link drawn as the header's icon button.
  const add = await view.findByRole("button", { name: "New Bot" });
  expect(add.getAttribute("href")).toBe("/bots?new=true");
});

test("opening a conversation from under its Bot keeps the Bots panel there", async () => {
  served.invoice = () =>
    Response.json(
      conversationPage([conversation("i1", ["invoice"], "Open Acme invoices")]),
    );
  const { view, user, router } = renderPanel();
  await user.click(await view.findByText("Open Acme invoices"));
  await waitFor(() =>
    expect(router.state.location.pathname).toBe("/channel/i1"),
  );
  expect(view.getByRole("heading", { level: 2, name: "Bots" })).toBeTruthy();
});

test("a Bot's pinned conversations stay first under it, whatever moved since", async () => {
  // As a live message leaves the cache: a newer unpinned one ahead of the pinned one.
  served.invoice = () =>
    Response.json(
      conversationPage([
        conversation(
          "new",
          ["invoice"],
          "Just now",
          "2026-11-09T10:00:00.000Z",
        ),
        {
          ...conversation("pin", ["invoice"], "Pinned one"),
          pinned: true,
        },
      ]),
    );
  const { view } = renderPanel();
  await view.findByText("Just now");
  // The Bots panel's own rows: the Conversations panel stays mounted beside it, out of sight.
  const panel = view
    .getByRole("heading", { level: 2, name: "Bots" })
    .closest("[data-slot=section-panel]");
  const titles = [
    ...(panel?.querySelectorAll<HTMLElement>("a[href^='/channel/']") ?? []),
  ].map((link) => link.textContent);
  expect(titles[0]).toContain("Pinned one");
  expect(titles[1]).toContain("Just now");
});

test("after switching to Conversations, a conversation opened there keeps Conversations", async () => {
  served.invoice = () =>
    Response.json(
      conversationPage([conversation("i1", ["invoice"], "Open Acme invoices")]),
    );
  served["(all)"] = () =>
    Response.json(
      conversationPage([conversation("c9", ["finance"], "From the list")]),
    );
  const { view, user, router } = renderPanel();
  await user.click(await view.findByText("Open Acme invoices"));
  await waitFor(() =>
    expect(router.state.location.pathname).toBe("/channel/i1"),
  );
  await user.click(view.getByRole("button", { name: "Chats" }));
  await view.findByRole("heading", { level: 2, name: "Conversations" });
  await router.navigate({
    to: "/channel/$channelId",
    params: { channelId: "c9" },
  });
  await waitFor(() =>
    expect(router.state.location.pathname).toBe("/channel/c9"),
  );
  expect(
    view.getByRole("heading", { level: 2, name: "Conversations" }),
  ).toBeTruthy();
});

test("a Bot's row is filled only on hover, not for being its page", async () => {
  const { view, router } = renderPanel();
  await view.findByRole("heading", { level: 2, name: "Bots" });
  await router.navigate({
    to: "/bots/$agentId",
    params: { agentId: "invoice" },
  });
  const link = await view.findByRole("link", { name: /^Invoice Review/ });
  await waitFor(() => expect(link.getAttribute("data-status")).toBe("active"));
  expect(link.className.split(/\s+/)).not.toContain("bg-foreground/5");
});

test("right-clicking a Bot offers a new conversation with it", async () => {
  const { view, user, router } = renderPanel();
  const bot = await view.findByRole("link", { name: /^Old Helper/ });
  fireEvent.contextMenu(bot);
  await user.click(
    await view.findByRole("menuitem", {
      name: "New conversation with Old Helper",
    }),
  );
  await waitFor(() =>
    expect(router.state.location.pathname).toBe("/channel/new"),
  );
  expect(router.state.location.search).toEqual({ agent: "old" });
});
