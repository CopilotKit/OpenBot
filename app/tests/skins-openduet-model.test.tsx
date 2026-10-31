import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, waitFor, within } from "@testing-library/react";
import { TaskList } from "@/components/tasks/task-list";
import type { ApprovalInboxData } from "@/lib/approvals";
import { needsYouCount } from "@/lib/tasks/groups";
import type { TaskRecord } from "@/lib/tasks/queries";
import { queryClient } from "@/query-client";
import {
  columnFor,
  conversationPath,
  isSkinScreen,
  tabForPath,
} from "@/skins/openduet/places";
import { settleReactWork } from "./settle-react-work";

/*
 * The rules OpenDuet's frame runs on. Which paths are tabs decides whether a screen has a tab bar
 * or a back disc; which column a path gets decides whether a page keeps OpenBot's width; and the
 * Tasks badge has to count exactly the rows OpenBot's own Tasks lists under Needs you.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(() => {
  cleanup();
  queryClient.clear();
});
const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
});
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

describe("which tab a path is", () => {
  test("every conversation OpenBot draws is Chat", () => {
    for (const path of [
      "/",
      "/channel/new",
      "/channel/c-1",
      "/group/g-1",
      "/group/new",
      "/bot",
      "/channel/c-1/",
    ])
      expect(tabForPath(path)).toBe("chat");
  });

  test("OpenBot's Tasks, and every task opened from it, is the Tasks tab", () => {
    for (const path of ["/tasks", "/tasks/", "/tasks/t-1"]) {
      expect(tabForPath(path)).toBe("tasks");
      // OpenBot's own page, which owns its scrollers: not one of the skin's screens.
      expect(isSkinScreen(path)).toBe(false);
    }
    expect(tabForPath("/s/tasks")).toBeNull();
    expect(tabForPath("/taskstuff")).toBeNull();
  });

  test("every other page opens over the app, with no tab", () => {
    for (const path of [
      "/bots",
      "/bots/b-1",
      "/bots/b-1/responsibilities",
      "/routines",
      "/capabilities/skills",
      "/capabilities/memory",
      "/connections",
      "/channel/c-1/extra",
    ]) {
      expect(tabForPath(path)).toBeNull();
      expect(isSkinScreen(path)).toBe(false);
    }
  });

  test("a conversation with several Bots opens as a group", () => {
    expect(conversationPath({ id: "c", agentIds: ["a"] })).toBe("/channel/c");
    expect(conversationPath({ id: "g", agentIds: ["a", "b"] })).toBe(
      "/group/g",
    );
  });
});

/*
 * Found in review: the 430px column held every page, so a Bot's page, Admin and the computer were
 * squeezed into a phone's width on a wide screen. Only Chat and Tasks are phone-shaped now.
 */
describe("how wide the column is", () => {
  test("Chat and Tasks are a phone's width", () => {
    expect(columnFor("/")).toBe("phone");
    expect(columnFor("/channel/c-1")).toBe("phone");
    expect(columnFor("/tasks")).toBe("phone");
    expect(columnFor("/tasks/t-1")).toBe("phone");
  });

  test("a conversation with its computer or its Bot's details open has room for OpenBot's pane", () => {
    expect(columnFor("/channel/c-1", { watch: true })).toBe("pane");
    expect(columnFor("/channel/c-1", { settings: true })).toBe("pane");
    expect(columnFor("/bot", { watch: true })).toBe("pane");
  });

  test("every other page keeps OpenBot's own width", () => {
    for (const path of [
      "/bots",
      "/bots/b-1",
      "/bots/b-1/setup",
      "/routines",
      "/capabilities/skills",
      "/connections",
    ])
      expect(columnFor(path)).toBe("page");
  });
});

const task = (
  id: string,
  status: TaskRecord["status"],
  threadId = `${id}-thread`,
): TaskRecord => ({
  id,
  botId: "b-1",
  channelId: `${id}-channel`,
  threadId,
  title: `Task ${id}`,
  why: null,
  origin: "asked",
  suggestionId: null,
  sourceApp: null,
  sourceLink: null,
  status,
  failure: null,
  failedAt: null,
  next: null,
  queuedReplies: [],
  answeredQuestionIds: [],
  resolvedAt: null,
  createdAt: "2026-10-27T10:00:00.000Z",
  updatedAt: "2026-10-27T10:00:00.000Z",
});

/*
 * The Tasks tab used to count every approval and question OpenBot's waiting list drew. Tasks is
 * OpenBot's own now, and the tab counts what it lists under Needs you: the tasks waiting on the
 * person, an approval in a task's own conversation included, and nothing outside any task. This
 * renders OpenBot's list against the same tasks and inbox and holds the two to the same number, so
 * a change to what the list shows fails here rather than leaving a badge that disagrees with it.
 */
test("the Tasks badge counts exactly what OpenBot's Tasks lists under Needs you", async () => {
  const tasks = [
    task("ask", "needs_input"),
    task("held", "working"),
    task("run", "working"),
    task("read", "ready_for_review"),
  ];
  const inbox: ApprovalInboxData = {
    enabled: true,
    rules: [],
    teamRules: [],
    requests: [
      {
        id: "in-task",
        status: "pending",
        createdAt: "2026-10-27T10:00:00.000Z",
        action: {
          botId: "b-1",
          toolRef: "computer_run_command",
          effect: "write",
          scope: "workspace",
          threadId: "held-thread",
          args: { command: "echo hello" },
          target: null,
        },
      },
    ],
    questions: [
      {
        id: "loose",
        botId: "b-1",
        threadId: "chat-thread",
        question: "Which kiln?",
        createdAt: "2026-10-27T10:00:00.000Z",
      },
    ],
  };
  global.fetch = (async (input: RequestInfo | URL) => {
    const path = String(input).split("?")[0];
    if (path === "/api/tasks") return Response.json({ tasks });
    if (path === "/api/approvals") return Response.json(inbox);
    if (path === "/api/agents")
      return Response.json({ agents: [{ id: "b-1", name: "Ops Bot" }] });
    if (path === "/api/channels")
      return Response.json({ channels: [], nextCursor: null });
    if (path === "/api/proactive/suggestions")
      return Response.json({ suggestions: [] });
    return Response.json({ error: "not served" }, { status: 404 });
  }) as typeof fetch;
  const router = createRouter({
    routeTree: createRootRoute({ component: () => <TaskList /> }),
    history: createMemoryHistory({ initialEntries: ["/tasks"] }),
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
  const needs = await view.findByRole("region", { name: /^Needs you/ });
  await waitFor(() =>
    expect(within(needs).getAllByRole("link").length).toBe(
      needsYouCount(tasks, inbox),
    ),
  );
  expect(needsYouCount(tasks, inbox)).toBe(2);
  expect(needsYouCount(undefined, undefined)).toBe(0);
});
