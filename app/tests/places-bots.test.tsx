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
import { upcomingOf } from "@/components/bot-profile/activity";
import { botsPlace } from "@/components/places/bots-place";
import { type AgentProfile, agentKeys } from "@/lib/agents/queries";
import {
  type ActivityItem,
  botLifecycleKeys,
} from "@/lib/bot-lifecycle/queries";
import { channelKeys } from "@/lib/channels/queries";
import { deploymentKeys } from "@/lib/deployment/queries";
import { activityOf, activityResponse, botOperationPath } from "./bots-api";
import { settleReactWork } from "./settle-react-work";

/*
 * The Bots place's list: Needs you, Pinned, Yours and Shared with you, each drawn only when it has
 * Bots, and each Bot's activity read only once its row is opened.
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

function renderPlace({
  roster,
  waiting = {},
  rosterFails = false,
}: {
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
    pages: [{ channels: [], nextCursor: null }],
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

test("a Bot's activity is read only when its row is opened", async () => {
  let reads = 0;
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL) => {
      if (String(input) === botOperationPath("mine", "activity")) {
        reads += 1;
        return activityResponse();
      }
      return Response.json({ error: "not served" }, { status: 404 });
    },
    { preconnect: originalFetch.preconnect },
  );
  const { view } = renderPlace({ roster: four });
  await view.findByText("Mine");
  expect(reads).toBe(0);

  fireEvent.click(view.getByRole("button", { name: "What Mine is doing" }));
  await view.findByText("Nothing is running or lined up.");
  expect(reads).toBe(1);
});

test("a Bot's activity that can't be read says so, not that nothing is under way", async () => {
  globalThis.fetch = Object.assign(
    async () => Response.json({ error: "down" }, { status: 500 }),
    { preconnect: originalFetch.preconnect },
  );
  const { view } = renderPlace({ roster: four });
  await view.findByText("Mine");
  fireEvent.click(view.getByRole("button", { name: "What Mine is doing" }));
  await view.findByText(
    "Couldn't load what it is doing. Try again in a moment.",
  );
  expect(view.queryByText("Nothing is running or lined up.")).toBeNull();
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

const item = (id: string): ActivityItem => ({
  id,
  kind: "routine",
  title: id,
  detail: null,
  status: "scheduled",
  at: "2026-10-09T10:00:00Z",
  channelId: null,
  needsYou: false,
  stoppable: false,
  cancellable: false,
});

test("upcomingOf lists running work before what is lined up, three at most", () => {
  const upcoming = upcomingOf(
    activityOf({
      inProgress: [item("running")],
      scheduled: [item("a"), item("b"), item("c")],
    }),
  );
  expect(upcoming.map(({ item: found, live }) => [found.id, live])).toEqual([
    ["running", true],
    ["a", false],
    ["b", false],
  ]);
  expect(upcomingOf(undefined)).toEqual([]);
});
