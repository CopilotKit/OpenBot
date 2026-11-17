import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render } from "@testing-library/react";
import { createElement } from "react";
import { atWorkPlace } from "@/components/places/at-work-place";
import { agentKeys } from "@/lib/agents/queries";
import {
  type ChannelSummary,
  type ChannelWork,
  channelKeys,
} from "@/lib/channels/queries";
import { atWork } from "@/lib/places/at-work";
import type { ListedTask } from "@/lib/tasks/groups";
import { type BotTask, type TaskStatus, taskKeys } from "@/lib/tasks/queries";
import { settleReactWork } from "./settle-react-work";

const originalFetch = globalThis.fetch;
const clients: QueryClient[] = [];

beforeAll(() => {
  GlobalRegistrator.register({
    url: "http://localhost/",
    width: 1280,
    height: 840,
  });
});
afterEach(() => {
  cleanup();
  for (const client of clients) client.clear();
  clients.length = 0;
  globalThis.fetch = originalFetch;
});
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

function channel(overrides: Partial<ChannelSummary>): ChannelSummary {
  return {
    id: "c1",
    name: "Assistant",
    agentIds: ["b1"],
    threadId: "thread-1",
    active: true,
    summary: null,
    lastMessage: null,
    lastMessageAt: null,
    lastMessageAgentId: null,
    createdAt: "2026-11-17T09:00:00.000Z",
    pinned: false,
    lastReadAt: null,
    ...overrides,
  };
}

function handoff(since: string): ChannelWork {
  return {
    kind: "handoff",
    key: `h-${since}`,
    botId: "b2",
    botName: null,
    since,
  };
}

function listed(
  status: TaskStatus,
  overrides: Partial<BotTask> = {},
): ListedTask {
  const task: BotTask = {
    id: "t1",
    agentId: "b1",
    channelId: "t1-channel",
    threadId: null,
    title: "A task",
    why: null,
    origin: "check_in",
    suggestionId: null,
    sourceApp: null,
    sourceLink: null,
    originChannelId: null,
    status,
    failure: null,
    failedAt: null,
    next: null,
    resolvedAt: null,
    createdAt: "2026-11-17T09:00:00.000Z",
    updatedAt: "2026-11-17T09:00:00.000Z",
    ...overrides,
  };
  return { task, status };
}

test("a busy conversation and a conversation with owed work are each one row", () => {
  const rows = atWork(
    [
      channel({ id: "c1", busy: true, work: undefined }),
      channel({
        id: "c2",
        busy: false,
        work: [handoff("2026-11-17T10:00:00Z")],
      }),
    ],
    [],
  );
  expect(rows).toHaveLength(2);
});

test("a working task whose conversation is in the list too is listed once", () => {
  const rows = atWork(
    [channel({ id: "c1", busy: true })],
    [listed("working", { channelId: "c1" })],
  );
  expect(rows).toHaveLength(1);
  expect(rows[0]?.channelId).toBe("c1");
});

test("a working task whose conversation is not in the list is still listed", () => {
  const rows = atWork(
    [],
    [
      listed("working", {
        channelId: "t9",
        agentId: "b1",
        title: "Draft the brief",
      }),
    ],
  );
  expect(rows).toEqual([
    {
      channelId: "t9",
      agentIds: ["b1"],
      title: "Draft the brief",
      work: [],
      since: null,
      group: false,
    },
  ]);
});

test("idle conversations and tasks that are not working are left out", () => {
  const rows = atWork(
    [channel({ id: "c1", busy: false, work: [] })],
    [
      listed("ready_for_review", { channelId: "a" }),
      listed("needs_input", { channelId: "b" }),
      listed("failed", { channelId: "c" }),
      listed("resolved", { channelId: "d" }),
    ],
  );
  expect(rows).toEqual([]);
});

test("the longest-running comes first", () => {
  const rows = atWork(
    [
      channel({ id: "none-1", busy: true }),
      channel({ id: "late", work: [handoff("2026-11-17T10:05:00Z")] }),
      channel({ id: "none-2", busy: true }),
      channel({ id: "early", work: [handoff("2026-11-17T10:00:00Z")] }),
    ],
    [],
  );
  expect(rows.map((row) => row.channelId)).toEqual([
    "early",
    "late",
    "none-1",
    "none-2",
  ]);
});

/** The place's list drawn over a conversation read and a task read, either of which may fail. */
function renderPlace({
  channelsFail = false,
  tasksFail = false,
}: {
  channelsFail?: boolean;
  tasksFail?: boolean;
}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  clients.push(queryClient);
  if (channelsFail || tasksFail) {
    globalThis.fetch = Object.assign(
      async () => Response.json({ error: "down" }, { status: 500 }),
      { preconnect: originalFetch.preconnect },
    );
  }
  if (!channelsFail) {
    queryClient.setQueryData(channelKeys.list(), {
      pages: [{ channels: [], nextCursor: null }],
      pageParams: [""],
    });
  }
  if (!tasksFail) queryClient.setQueryData(taskKeys.list, []);
  queryClient.setQueryData(agentKeys.list(false), []);
  queryClient.setQueryData(agentKeys.list(true), []);
  const router = createRouter({
    routeTree: createRootRoute({
      component: () =>
        createElement(atWorkPlace.List, { scrollRoot: { current: null } }),
    }),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  return render(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(RouterProvider, { router: router as never }),
    ),
  );
}

test("with nothing running the list says so", async () => {
  const view = renderPlace({});
  await view.findByText("Nothing is running right now.");
});

test("when the conversations can't be read the list says so, not that nothing is running", async () => {
  const view = renderPlace({ channelsFail: true });
  await view.findByText(
    "Couldn't load what is running. Try again in a moment.",
  );
  expect(view.queryByText("Nothing is running right now.")).toBeNull();
});

test("when the tasks can't be read the list says so, not that nothing is running", async () => {
  const view = renderPlace({ tasksFail: true });
  await view.findByText(
    "Couldn't load what is running. Try again in a moment.",
  );
  expect(view.queryByText("Nothing is running right now.")).toBeNull();
});
