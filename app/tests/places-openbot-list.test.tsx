import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type { ComponentType } from "react";
import { openbotPlace } from "@/components/places/openbot-place";
import { agentKeys } from "@/lib/agents/queries";
import type { ApprovalInboxData } from "@/lib/approvals";
import { botLifecycleKeys } from "@/lib/bot-lifecycle/queries";
import { type ChannelSummary, channelKeys } from "@/lib/channels/queries";
import { proactiveKeys } from "@/lib/proactive";
import { routineKeys } from "@/lib/routines/queries";
import { type BotTask, taskKeys } from "@/lib/tasks/queries";
import { settleReactWork } from "./settle-react-work";

/*
 * For you, the place behind the orb: Needs you, Working on and Recent, each drawn only when it has
 * rows. A question or an action opens beside the list, and the page behind does not change.
 */

const OpenBotPlace = openbotPlace.List;
const ForYouBadge = openbotPlace.Badge as ComponentType;

function conversation(
  id: string,
  extra: Partial<ChannelSummary> = {},
): ChannelSummary {
  return {
    id,
    name: "Inbox",
    agentIds: ["inbox"],
    threadId: `thread-${id}`,
    active: true,
    summary: `Conversation ${id}`,
    lastMessage: null,
    lastMessageAt: AT,
    lastMessageAgentId: null,
    createdAt: AT,
    pinned: false,
    lastReadAt: AT,
    ...extra,
  };
}

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
  globalThis.fetch = Object.assign(
    async () => Response.json({ error: "not served" }, { status: 404 }),
    { preconnect: originalFetch.preconnect },
  );
});
afterEach(() => {
  cleanup();
  for (const client of clients) client.clear();
  clients.length = 0;
});
afterAll(async () => {
  await settleReactWork();
  globalThis.fetch = originalFetch;
  globalThis.WebSocket = originalWebSocket;
  GlobalRegistrator.unregister();
});

const AT = "2026-11-17T10:00:00Z";

const question = {
  id: "q1",
  botId: "inbox",
  threadId: "thread-q1",
  channelId: "chan-q1",
  question: "Which invoice should I chase?",
  createdAt: AT,
};

const task = (id: string, status: BotTask["status"]): BotTask => ({
  id,
  agentId: "inbox",
  channelId: `chan-${id}`,
  threadId: `thread-${id}`,
  title: `Task ${id}`,
  why: null,
  origin: "check_in",
  suggestionId: null,
  sourceApp: null,
  sourceLink: null,
  originChannelId: null,
  status,
  failure: null,
  failedAt: null,
  stoppedAt: null,
  next: null,
  resolvedAt: status === "resolved" ? AT : null,
  createdAt: AT,
  updatedAt: AT,
});

const shareRequest = {
  id: "approval-share",
  status: "pending",
  createdAt: AT,
  action: {
    botId: "inbox",
    toolRef: "openbot/share_private_information",
    effect: "share_private",
    scope: "handoff:noor",
    threadId: "thread-share",
    toolCallId: "call-handoff",
    covers: "4be1",
    args: {
      audience: "Ledger Bot",
      recipients: 1,
      contentDigest: "9f2c",
      preview: "Find the ledger code.",
      handOff: "Ledger Bot",
    },
    target: { kind: "handoff", id: "noor" },
  },
};

type Seed = {
  questions?: (typeof question)[];
  requests?: (typeof shareRequest)[];
  /** The approval inbox read fails instead of answering. */
  inboxFails?: boolean;
  tasks?: BotTask[];
  /** Bots on the roster. */
  roster?: { id: string; name: string }[];
  /** Bots the attention read names. */
  attention?: { botId: string; name: string }[];
  /** The conversation list, newest first. */
  channels?: ChannelSummary[];
  /** The person's routines, as the routines read answers. */
  routines?: { id: string; title: string | null; instruction: string }[];
};

function renderPlace(seed: Seed = {}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  clients.push(queryClient);
  queryClient.setQueryDefaults(botLifecycleKeys.attention, {
    staleTime: Number.POSITIVE_INFINITY,
    refetchInterval: false,
  });
  if (seed.inboxFails) {
    queryClient.setQueryDefaults(["approvals"], {
      queryFn: async () => {
        throw new Error("Your approvals could not be loaded.");
      },
    });
  } else {
    queryClient.setQueryData(["approvals"], {
      enabled: true,
      requests: seed.requests ?? [],
      questions: seed.questions ?? [],
    } as unknown as ApprovalInboxData);
  }
  queryClient.setQueryData(taskKeys.list, seed.tasks ?? []);
  queryClient.setQueryData(proactiveKeys.suggestions, []);
  queryClient.setQueryData(
    agentKeys.list(false),
    (seed.roster ?? []).map((bot) => ({ ...bot, avatarSeed: bot.id })),
  );
  queryClient.setQueryData(botLifecycleKeys.attention, {
    bots: (seed.attention ?? []).map((bot) => ({
      ...bot,
      questions: 0,
      approvals: 0,
      handoffs: 0,
      unread: 0,
      paused: false,
      items: 0,
      tasks: {},
      waitingIn: null,
    })),
    lastPingId: null,
  });
  queryClient.setQueryData(agentKeys.list(true), []);
  queryClient.setQueryData(channelKeys.list(), {
    pages: [{ channels: seed.channels ?? [], nextCursor: null }],
    pageParams: [""],
  });
  queryClient.setQueryData(routineKeys.list(), {
    routines: seed.routines ?? [],
  });
  const router = createRouter({
    routeTree: createRootRoute({
      component: () => (
        <>
          <span data-testid="strip">
            <ForYouBadge />
          </span>
          <OpenBotPlace scrollRoot={{ current: null }} />
        </>
      ),
    }),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { view, router };
}

test("the three sections are drawn only when they have rows", async () => {
  const { view } = renderPlace({
    questions: [question],
    roster: [{ id: "inbox", name: "Inbox" }],
  });
  await view.findByText("Which invoice should I chase?");
  expect(view.getByRole("heading", { name: /Needs you/ })).toBeTruthy();
  expect(view.queryByRole("heading", { name: /Working on/ })).toBeNull();
  expect(view.queryByRole("heading", { name: /Recent/ })).toBeNull();
  expect(view.queryByRole("heading", { name: /Done this week/ })).toBeNull();
});

test("a running routine is listed by its name and its Bot, and the orb pulses", async () => {
  const { view } = renderPlace({
    roster: [{ id: "inbox", name: "Inbox" }],
    routines: [
      { id: "r1", title: "Weekday leads", instruction: "Find new leads" },
    ],
    channels: [
      conversation("routine-home", {
        work: [
          {
            kind: "routine",
            key: "run-1",
            routineId: "r1",
            botId: "inbox",
            botName: null,
            since: AT,
          },
        ],
      }),
    ],
  });
  const row = await view.findByRole("link", { name: /Weekday leads/ });
  expect(row.textContent).toContain("Inbox");
  expect(row.getAttribute("href")).toBe("/channel/routine-home");
  expect(view.getByRole("heading", { name: /Working on/ })).toBeTruthy();
  expect(view.getByTestId("strip").textContent).toBe("Running");
});

test("work owed by another Bot is under Working on with who was asked", async () => {
  const { view } = renderPlace({
    roster: [
      { id: "inbox", name: "Inbox" },
      { id: "ops", name: "Ops" },
    ],
    channels: [
      conversation("asked", {
        work: [
          {
            kind: "handoff",
            key: "hop-1",
            botId: "ops",
            botName: null,
            since: AT,
          },
        ],
      }),
    ],
  });
  await view.findByRole("link", { name: /Conversation asked/ });
  expect(view.getByText("Asked Ops")).toBeTruthy();
  expect(view.queryByRole("heading", { name: /Recent/ })).toBeNull();
});

test("a Bot answering the person's message lights nothing and stays under Recent", async () => {
  const { view } = renderPlace({
    roster: [{ id: "inbox", name: "Inbox" }],
    channels: [conversation("chatting", { busy: true })],
  });
  await view.findByRole("heading", { name: /Recent/ });
  expect(view.queryByRole("heading", { name: /Working on/ })).toBeNull();
  expect(view.getByTestId("strip").textContent).toBe("");
});

test("Recent lists the latest conversations, eight at most, each opening it", async () => {
  const { view } = renderPlace({
    roster: [{ id: "inbox", name: "Inbox" }],
    channels: Array.from({ length: 10 }, (_, index) =>
      conversation(`c${index}`),
    ),
  });
  const heading = await view.findByRole("heading", { name: /Recent/ });
  const links = [
    ...((heading.closest("section") as Element).querySelectorAll("a") ?? []),
  ];
  expect(links.map((link) => link.getAttribute("href"))).toEqual(
    ["c0", "c1", "c2", "c3", "c4", "c5", "c6", "c7"].map(
      (id) => `/channel/${id}`,
    ),
  );
});

test("a question opens beside the list and the page does not change", async () => {
  const { view, router } = renderPlace({
    questions: [question],
    roster: [{ id: "inbox", name: "Inbox" }],
  });
  const row = await view.findByRole("button", {
    name: /Which invoice should I chase\?/,
  });
  fireEvent.click(row);
  const popover = await waitFor(() => {
    const found = document.querySelector('[data-slot="popover-content"]');
    expect(found).not.toBeNull();
    return found as HTMLElement;
  });
  expect(popover.textContent).toContain("Which invoice should I chase?");
  expect(
    Array.from(popover.querySelectorAll("button")).some(
      (button) => button.textContent === "Answer",
    ),
  ).toBe(true);
  expect(router.state.location.pathname).toBe("/");
});

test("a task's row opens its conversation", async () => {
  const { view, router } = renderPlace({
    tasks: [task("t1", "needs_input")],
    roster: [{ id: "inbox", name: "Inbox" }],
  });
  const row = await view.findByRole("link", { name: /Task t1/ });
  fireEvent.click(row);
  await waitFor(() =>
    expect(router.state.location.pathname).toBe("/channel/chan-t1"),
  );
});

test("a row from a Bot that is hidden still says its name", async () => {
  const { view } = renderPlace({
    questions: [question],
    roster: [],
    attention: [{ botId: "inbox", name: "Quiet Inbox" }],
  });
  const row = await view.findByRole("button", {
    name: /Which invoice should I chase\?/,
  });
  expect(row.textContent).toContain("Quiet Inbox");
});

test("with nothing in any section the list says so", async () => {
  const { view } = renderPlace();
  await view.findByText(
    "Nothing yet. Your conversations and what your Bots are doing show up here.",
  );
  expect(view.getByRole("link", { name: /New conversation/ })).toBeTruthy();
  expect(view.queryByRole("heading", { name: /Needs you/ })).toBeNull();
});

test("a share request's row names who it goes to", async () => {
  const { view } = renderPlace({
    requests: [shareRequest],
    roster: [{ id: "inbox", name: "Inbox" }],
  });
  const row = await view.findByRole("button", { name: /Hand this to/ });
  expect(row.textContent).toContain("Ledger Bot");
});

test("Answer opens the conversation and closes the popover", async () => {
  const { view, router } = renderPlace({
    questions: [question],
    roster: [{ id: "inbox", name: "Inbox" }],
  });
  fireEvent.click(
    await view.findByRole("button", { name: /Which invoice should I chase\?/ }),
  );
  const popover = await waitFor(() => {
    const found = document.querySelector('[data-slot="popover-content"]');
    expect(found).not.toBeNull();
    return found as HTMLElement;
  });
  const answer = Array.from(popover.querySelectorAll("button")).find(
    (button) => button.textContent === "Answer",
  );
  fireEvent.click(answer as HTMLElement);
  await waitFor(() =>
    expect(router.state.location.pathname).toBe("/channel/chan-q1"),
  );
  await waitFor(() =>
    expect(document.querySelector('[data-slot="popover-content"]')).toBeNull(),
  );
});

test("when the approval inbox can't be read the list says so, not that nothing needs you", async () => {
  const { view } = renderPlace({ inboxFails: true });
  await view.findByText("Couldn't load what needs you. Try again in a moment.");
  expect(view.queryByText(/Nothing needs you/)).toBeNull();
});
