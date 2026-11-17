import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { botsPlace, recentWith } from "@/components/places/bots-place";
import { type AgentProfile, agentKeys } from "@/lib/agents/queries";
import { botLifecycleKeys } from "@/lib/bot-lifecycle/queries";
import { type ChannelSummary, channelKeys } from "@/lib/channels/queries";
import { deploymentKeys } from "@/lib/deployment/queries";
import { settleReactWork } from "./settle-react-work";

/*
 * The Bots place's list: Needs you, Pinned, Yours and Shared with you, each drawn only when it has
 * Bots, and each Bot's latest conversations under its row once the row is opened.
 */

const BotsPlace = botsPlace.List;

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

function bot(overrides: Partial<AgentProfile> & { id: string }): AgentProfile {
  return {
    assignedToMe: false,
    runsOnOpenBotModel: false,
    keyFromOpenBot: false,
    name: overrides.id,
    title: "Title",
    roleDescription: "Role",
    avatarSeed: overrides.id,
    visibility: "private",
    endpoint: null,
    builtIn: true,
    hasAuth: false,
    hasCallbackToken: false,
    isolated: false,
    isolationActive: false,
    isolationOffReason: null,
    hidden: false,
    pinned: false,
    systemOwned: false,
    canManage: true,
    mine: true,
    ...overrides,
  };
}

/** What each Bot has waiting on the person: `questions` of them, and nothing else. */
function attentionFor(botId: string, questions: number) {
  return {
    botId,
    name: botId,
    questions,
    approvals: 0,
    handoffs: 0,
    unread: 0,
    paused: false,
    notify: "all",
    items: 0,
    tasks: { needsInput: 0, ready: 0, failed: 0 },
    waitingIn: null,
  };
}

/** A conversation with `agentIds`, last spoken in at `lastMessageAt` (null: never used). */
function conversation(
  id: string,
  agentIds: string[],
  lastMessageAt: string | null,
  summary: string | null = id,
): ChannelSummary {
  return {
    id,
    name: agentIds[0] ?? "Bot",
    agentIds,
    threadId: `thread-${id}`,
    active: true,
    summary,
    lastMessage: null,
    lastMessageAt,
    lastMessageAgentId: null,
    createdAt: "2026-11-17T09:00:00.000Z",
    pinned: false,
    lastReadAt: null,
  };
}

function renderPlace({
  roster,
  waiting = {},
  rosterFails = false,
  channels = [],
}: {
  /** The conversations read so far, newest first, as the list arrives. */
  channels?: ChannelSummary[];
  roster: AgentProfile[];
  /** The roster read fails instead of answering. */
  rosterFails?: boolean;
  /** Questions waiting, by Bot id. */
  waiting?: Record<string, number>;
}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  clients.push(queryClient);
  queryClient.setQueryDefaults(botLifecycleKeys.attention, {
    staleTime: Number.POSITIVE_INFINITY,
    refetchInterval: false,
  });
  if (rosterFails) {
    globalThis.fetch = Object.assign(
      async () => Response.json({ error: "down" }, { status: 500 }),
      { preconnect: originalFetch.preconnect },
    );
  } else {
    queryClient.setQueryData(agentKeys.list(false), roster);
  }
  queryClient.setQueryData(botLifecycleKeys.attention, {
    bots: Object.entries(waiting).map(([id, questions]) =>
      attentionFor(id, questions),
    ),
    lastPingId: null,
  });
  queryClient.setQueryData(channelKeys.list(), {
    pages: [{ channels, nextCursor: null }],
    pageParams: [""],
  });
  queryClient.setQueryData(deploymentKeys.capabilities(), {
    edition: "business",
  });
  const router = createRouter({
    routeTree: createRootRoute({
      component: () => <BotsPlace scrollRoot={{ current: null }} />,
    }),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
  return { view };
}

const four = [
  bot({ id: "asker", name: "Asker" }),
  bot({ id: "starred", name: "Starred", pinned: true }),
  bot({ id: "mine", name: "Mine" }),
  bot({ id: "theirs", name: "Theirs", mine: false }),
];

test("the four sections are in order with the right Bots", async () => {
  const { view } = renderPlace({ roster: four, waiting: { asker: 1 } });
  await view.findByText("Asker");
  const headings = view.getAllByRole("heading").map((h) => h.textContent);
  expect(headings).toEqual(["Needs you", "Pinned", "Yours", "Shared with you"]);
  const under = (heading: string) =>
    (view.getByRole("heading", { name: heading }).closest("section") as Element)
      .textContent;
  expect(under("Needs you")).toContain("Asker");
  expect(under("Pinned")).toContain("Starred");
  expect(under("Yours")).toContain("Mine");
  expect(under("Shared with you")).toContain("Theirs");
  expect(under("Yours")).not.toContain("Starred");
});

test("a Bot with something waiting shows the count", async () => {
  const { view } = renderPlace({ roster: four, waiting: { asker: 1 } });
  const row = (await view.findByText("Asker")).closest("a") as HTMLElement;
  expect(row.textContent).toContain("1");
  const quiet = view.getByText("Mine").closest("a") as HTMLElement;
  expect(quiet.textContent).toBe("Mine");
});

test("an opened Bot with no conversations says so, and reads nothing for it", async () => {
  const reads: string[] = [];
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL) => {
      reads.push(String(input));
      return Response.json({ error: "not served" }, { status: 404 });
    },
    { preconnect: originalFetch.preconnect },
  );
  const { view } = renderPlace({ roster: four });
  await view.findByText("Mine");
  await settleReactWork();
  const before = reads.length;

  fireEvent.click(
    view.getByRole("button", { name: "Mine's latest conversations" }),
  );
  await view.findByText("No conversations with Mine yet.");
  await settleReactWork();
  expect(reads.length).toBe(before);
});

test("an opened Bot lists its five latest conversations, newest first, each opening it", async () => {
  const channels = [
    conversation("one", ["mine"], "2026-11-17T12:00:00Z"),
    conversation("someone else's", ["theirs"], "2026-11-17T11:30:00Z"),
    conversation("two", ["mine", "theirs"], "2026-11-17T11:00:00Z"),
    conversation("never used", ["mine"], null),
    conversation("three", ["mine"], "2026-11-17T10:00:00Z", null),
    conversation("four", ["mine"], "2026-11-17T09:00:00Z"),
    conversation("five", ["mine"], "2026-11-17T08:00:00Z"),
    conversation("six", ["mine"], "2026-11-17T07:00:00Z"),
  ];
  const { view } = renderPlace({ roster: four, channels });
  await view.findByText("Mine");
  expect(view.queryByText("one")).toBeNull();

  fireEvent.click(
    view.getByRole("button", { name: "Mine's latest conversations" }),
  );
  const first = await view.findByText("one");
  const links = [
    ...(first.closest("div.flex-col")?.querySelectorAll("a") ?? []),
  ];
  expect(links.map((link) => link.getAttribute("href"))).toEqual([
    "/channel/one",
    "/group/two",
    "/channel/three",
    "/channel/four",
    "/channel/five",
  ]);
  expect(view.getByText("New conversation")).toBeTruthy();
  expect(view.queryByText("six")).toBeNull();
  expect(view.queryByText("someone else's")).toBeNull();
  expect(view.queryByText("No conversations with Mine yet.")).toBeNull();
});

test("recentWith keeps one Bot's used conversations, five at most", () => {
  const channels = [
    conversation("a", ["x"], "2026-11-17T12:00:00Z"),
    conversation("b", ["y"], "2026-11-17T11:00:00Z"),
    conversation("c", ["x"], null),
    ...["d", "e", "f", "g", "h"].map((id) =>
      conversation(id, ["x", "y"], "2026-11-17T10:00:00Z"),
    ),
  ];
  expect(recentWith(channels, "x").map((found) => found.id)).toEqual([
    "a",
    "d",
    "e",
    "f",
    "g",
  ]);
  expect(recentWith(channels, "z")).toEqual([]);
});

test("a roster that can't be read says so", async () => {
  const { view } = renderPlace({ roster: [], rosterFails: true });
  await view.findByText("Couldn't load your Bots. Try again in a moment.");
});

test("a roster still being read draws nothing", async () => {
  globalThis.fetch = Object.assign(() => new Promise<Response>(() => {}), {
    preconnect: originalFetch.preconnect,
  });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  clients.push(queryClient);
  queryClient.setQueryData(deploymentKeys.capabilities(), {
    edition: "business",
  });
  const router = createRouter({
    routeTree: createRootRoute({
      component: () => <BotsPlace scrollRoot={{ current: null }} />,
    }),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
  await settleReactWork();
  expect(view.queryByText(/Couldn't load/)).toBeNull();
});

test("a Bot's row opens its page", async () => {
  const { view } = renderPlace({ roster: four });
  const row = (await view.findByText("Mine")).closest("a");
  expect(row?.getAttribute("href")).toBe("/bots/mine");
});
