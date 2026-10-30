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
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import {
  cleanup,
  fireEvent,
  render,
  waitFor,
  within,
} from "@testing-library/react";
import { BotNeedsYou } from "@/components/approvals/waiting";
import { BotRoster } from "@/components/bots/bot-roster";
import {
  TASKS_VIEW_STORAGE_KEY,
  TasksScreen,
} from "@/skins/openduet/tasks-screen";
import { queryClient } from "@/query-client";
import { settleReactWork } from "./settle-react-work";

/*
 * What a Bot's check-ins found and the tasks started from them, where the person meets them: the
 * Bots page's Needs you, the Bot's own page, and the OpenDuet skin's Tasks. All three are drawn at
 * once, in one cache, against a fake of OpenBot's API that keeps state the way the real routes do:
 * Hide takes an item off the open list, Start takes it off and opens a task, and a task's actions
 * move its status. The fake answers in the shapes `server/src/proactive/contracts.ts` promises.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
  window.localStorage.clear();
});

const now = new Date().toISOString();

type Item = {
  id: string;
  agentId: string;
  title: string;
  detail: string;
  sourceApp: string | null;
  sourceRef: string | null;
  sourceLink: string | null;
  pingId: string | null;
  createdAt: string;
};

type Task = {
  id: string;
  agentId: string;
  channelId: string;
  threadId: string | null;
  title: string;
  why: string | null;
  origin: "check_in";
  suggestionId: string | null;
  sourceApp: string | null;
  sourceLink: string | null;
  status:
    | "needs_input"
    | "working"
    | "resolved"
    | "failed"
    | "ready_for_review";
  failure: string | null;
  failedAt: string | null;
  next: string | null;
  resolvedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

const item = (overrides: Partial<Item> & { id: string; title: string }) => ({
  agentId: "inbox",
  detail: "Dana asked for the Q3 numbers by Friday.",
  sourceApp: "Gmail",
  sourceRef: "gmail/message/1",
  sourceLink: "https://mail.example.com/1",
  pingId: "ping-1",
  createdAt: now,
  ...overrides,
});

const task = (overrides: Partial<Task> & { id: string; title: string }) => ({
  agentId: "inbox",
  channelId: `c-${overrides.id}`,
  threadId: `t-${overrides.id}`,
  why: null,
  origin: "check_in" as const,
  suggestionId: null,
  sourceApp: "Gmail",
  sourceLink: null,
  status: "ready_for_review" as const,
  failure: null,
  failedAt: null,
  next: null,
  resolvedAt: null,
  createdAt: now,
  updatedAt: now,
  ...overrides,
});

let items: Item[] = [];
let tasks: Task[] = [];
/** Conversations a turn is running in right now, as the sidebar's live list says. */
let busy: string[] = [];
const sent: { method: string; path: string }[] = [];

function serving() {
  sent.length = 0;
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const method = init?.method ?? "GET";
    if (method !== "GET") sent.push({ method, path });
    const started = path.match(/^\/api\/proactive\/suggestions\/(.+)\/start$/);
    if (started) {
      const found = items.find((entry) => entry.id === started[1]);
      if (!found) return Response.json({ error: "Not open" }, { status: 404 });
      items = items.filter((entry) => entry !== found);
      const opened = task({
        id: `task-${found.id}`,
        agentId: found.agentId,
        title: found.title,
        why: found.detail,
        suggestionId: found.id,
        status: "working",
      });
      tasks = [opened, ...tasks];
      return Response.json({
        suggestion: { ...found, status: "started" },
        task: { id: opened.id, channelId: opened.channelId },
      });
    }
    const hidden = path.match(/^\/api\/proactive\/suggestions\/(.+)\/dismiss$/);
    if (hidden) {
      const found = items.find((entry) => entry.id === hidden[1]);
      items = items.filter((entry) => entry !== found);
      return Response.json({ suggestion: { ...found, status: "dismissed" } });
    }
    const acted = path.match(/^\/api\/tasks\/(.+)\/(resolve|reopen|again)$/);
    if (acted) {
      const [, id, action] = acted;
      tasks = tasks.map((entry) =>
        entry.id !== id
          ? entry
          : action === "resolve"
            ? { ...entry, status: "resolved", resolvedAt: now }
            : action === "reopen"
              ? { ...entry, status: "ready_for_review", resolvedAt: null }
              : { ...entry, status: "working", failure: null },
      );
      return Response.json({ task: tasks.find((entry) => entry.id === id) });
    }
    if (path === "/api/proactive/suggestions")
      return Response.json({ suggestions: items });
    if (path === "/api/tasks") return Response.json({ tasks });
    if (path.startsWith("/api/channels"))
      return Response.json({
        channels: busy.map((id) => ({
          id,
          name: "Task",
          agentIds: ["inbox"],
          threadId: `t-${id}`,
          active: true,
          lastMessageAt: now,
          summary: null,
          lastMessage: null,
          lastMessageAgentId: null,
          createdAt: now,
          pinned: false,
          lastReadAt: now,
          busy: true,
        })),
        nextCursor: null,
      });
    if (path === "/api/approvals")
      return Response.json({
        enabled: true,
        rules: [],
        teamRules: [],
        requests: [],
        questions: [],
      });
    if (path === "/api/bots/attention")
      return Response.json({ bots: [], lastPingId: null });
    if (path === "/api/routines")
      return Response.json({ routines: [], sweep: null });
    if (path === "/api/responsibilities")
      return Response.json({ responsibilities: [] });
    if (path.startsWith("/api/agents"))
      return Response.json({
        agents: path.includes("hidden=true")
          ? []
          : [
              { id: "inbox", name: "Inbox Bot", mine: true },
              { id: "ops", name: "Ops Bot", mine: true },
            ],
      });
    return Response.json({ error: "not served" }, { status: 404 });
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  items = [];
  tasks = [];
  busy = [];
  // Start, Hide and a task's actions invalidate the app's one cache, so the lists draw from it.
  queryClient.clear();
});

/** The Bots page, the Inbox Bot's page and OpenDuet's Tasks on its Up next list, side by side. */
async function drawAll() {
  window.localStorage.setItem(TASKS_VIEW_STORAGE_KEY, "up_next");
  const rootRoute = createRootRoute();
  const routeTree = rootRoute.addChildren([
    createRoute({
      getParentRoute: () => rootRoute,
      path: "/",
      component: () => (
        <>
          <section aria-label="Bots page">
            <BotRoster />
          </section>
          <section aria-label="Bot page">
            <BotNeedsYou agentId="inbox" />
          </section>
          <section aria-label="OpenDuet">
            <TasksScreen />
          </section>
        </>
      ),
    }),
    createRoute({
      getParentRoute: () => rootRoute,
      path: "/bots/$agentId",
      component: () => null,
    }),
    createRoute({
      getParentRoute: () => rootRoute,
      path: "/channel/$channelId",
      component: () => null,
    }),
  ]);
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  // Resolved before the first render, so the page is on screen from the start and stays there.
  await router.load();
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
  const region = (name: string) => within(view.getByRole("region", { name }));
  return { view, region };
}

test("an item says what it is, why, which Bot found it and where, with Start and Hide", async () => {
  items = [item({ id: "s1", title: "Send Dana the Q3 numbers" })];
  serving();
  const { view, region } = await drawAll();
  await view.findAllByText("Send Dana the Q3 numbers");
  const bots = region("Bots page");
  expect(bots.getByRole("heading", { name: "Needs you" })).toBeTruthy();
  expect(
    bots.getByText("Dana asked for the Q3 numbers by Friday."),
  ).toBeTruthy();
  expect(bots.getByText(/^Inbox Bot · From Gmail · /)).toBeTruthy();
  expect(bots.getByRole("button", { name: "Start" })).toBeTruthy();
  expect(bots.getByRole("button", { name: "Hide" })).toBeTruthy();
  const open = bots.getByRole("button", { name: "Open in Gmail" });
  expect(open.getAttribute("href")).toBe("https://mail.example.com/1");
  expect(open.getAttribute("target")).toBe("_blank");
});

test("Hide takes an item off the Bots page, the Bot's page and OpenDuet at once", async () => {
  items = [
    item({ id: "s1", title: "Send Dana the Q3 numbers" }),
    item({ id: "s2", title: "Renew the studio insurance" }),
  ];
  serving();
  const { view, region } = await drawAll();
  await waitFor(() =>
    expect(view.getAllByText("Send Dana the Q3 numbers")).toHaveLength(3),
  );
  const row = region("Bot page")
    .getByText("Send Dana the Q3 numbers")
    .closest("[data-slot=item]") as HTMLElement;
  fireEvent.click(within(row).getByRole("button", { name: "Hide" }));
  await waitFor(() =>
    expect(view.queryAllByText("Send Dana the Q3 numbers")).toHaveLength(0),
  );
  expect(sent).toContainEqual({
    method: "POST",
    path: "/api/proactive/suggestions/s1/dismiss",
  });
  // The other item stays on all three.
  expect(view.getAllByText("Renew the studio insurance")).toHaveLength(3);
});

test("Start takes the item off and shows its task, Working, opening its own conversation", async () => {
  items = [item({ id: "s1", title: "Send Dana the Q3 numbers" })];
  serving();
  const { view, region } = await drawAll();
  const bots = region("Bots page");
  fireEvent.click(await bots.findByRole("button", { name: "Start" }));
  await waitFor(() =>
    expect(bots.getByText(/^Working · Inbox Bot · /)).toBeTruthy(),
  );
  expect(sent).toEqual([
    { method: "POST", path: "/api/proactive/suggestions/s1/start" },
  ]);
  // The item became the task: no Start or Hide left for it anywhere.
  expect(view.queryAllByRole("button", { name: "Start" })).toHaveLength(0);
  expect(bots.getByText("Just started.")).toBeTruthy();
  const row = bots
    .getByText("Send Dana the Q3 numbers")
    .closest("[data-slot=item]") as HTMLElement;
  expect(
    within(row).getByRole("button", { name: "Open" }).getAttribute("href"),
  ).toBe("/channel/c-task-s1");
  // The Bot's own page lists it too.
  expect(region("Bot page").getByText(/^Working · Inbox Bot · /)).toBeTruthy();
});

test("tasks list what to read, answer and retry first, and each acts from its row", async () => {
  tasks = [
    task({ id: "w", title: "Draft the board update", status: "working" }),
    task({
      id: "f",
      title: "File the expense report",
      status: "failed",
      failure: "Gmail stopped answering",
    }),
    task({
      id: "r",
      title: "Reply to the landlord",
      status: "ready_for_review",
      next: "I drafted a reply. Want me to send it?",
    }),
    task({ id: "n", title: "Book the venue", status: "needs_input" }),
  ];
  serving();
  const { region } = await drawAll();
  const bots = region("Bots page");
  await bots.findByText("Reply to the landlord");
  const titles = [
    ...(bots
      .getByRole("heading", { name: "Needs you" })
      .closest("section")
      ?.querySelectorAll("[data-slot=item-title]") ?? []),
  ].map((title) => title.textContent);
  expect(titles).toEqual([
    "Reply to the landlord",
    "Book the venue",
    "File the expense report",
    "Draft the board update",
  ]);
  expect(bots.getByText("I drafted a reply. Want me to send it?")).toBeTruthy();
  expect(
    bots.getByText("Couldn't finish: Gmail stopped answering."),
  ).toBeTruthy();

  fireEvent.click(bots.getByRole("button", { name: "Try again" }));
  await waitFor(() =>
    expect(sent).toContainEqual({ method: "POST", path: "/api/tasks/f/again" }),
  );
  await waitFor(() =>
    expect(
      bots.queryByText("Couldn't finish: Gmail stopped answering."),
    ).toBeNull(),
  );

  const ready = bots
    .getByText("Reply to the landlord")
    .closest("[data-slot=item]") as HTMLElement;
  fireEvent.click(within(ready).getByRole("button", { name: "Mark done" }));
  // Marked done, it leaves Needs you for the folded Done list, where it can be reopened.
  const done = await bots.findByRole("heading", { name: "Done" });
  const section = within(done.closest("section") as HTMLElement);
  expect(section.getByText("1 task you marked done this week.")).toBeTruthy();
  fireEvent.click(section.getByRole("button", { name: "Show" }));
  fireEvent.click(section.getByRole("button", { name: "Reopen" }));
  await waitFor(() =>
    expect(sent).toContainEqual({
      method: "POST",
      path: "/api/tasks/r/reopen",
    }),
  );
  await waitFor(() =>
    expect(bots.queryByRole("heading", { name: "Done" })).toBeNull(),
  );
});

test("a task whose conversation is running a turn reads Working, whatever the server last said", async () => {
  tasks = [task({ id: "r", title: "Reply to the landlord" })];
  busy = ["c-r"];
  serving();
  const { region } = await drawAll();
  const bots = region("Bots page");
  await waitFor(() =>
    expect(bots.getByText(/^Working · Inbox Bot · /)).toBeTruthy(),
  );
});

test("OpenDuet's Active lists the tasks under OpenDuet's headings, in its order", async () => {
  window.localStorage.setItem(TASKS_VIEW_STORAGE_KEY, "active");
  tasks = [
    task({ id: "w", title: "Draft the board update", status: "working" }),
    task({ id: "r", title: "Reply to the landlord" }),
  ];
  serving();
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const rootRoute = createRootRoute({ component: TasksScreen });
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      createRoute({
        getParentRoute: () => rootRoute,
        path: "/channel/$channelId",
        component: () => null,
      }),
    ]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  const view = render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
  const ready = await view.findByRole("region", { name: "Ready for review" });
  expect(within(ready).getByText("Reply to the landlord")).toBeTruthy();
  const working = view.getByRole("region", { name: "Working" });
  expect(within(working).getByText("Draft the board update")).toBeTruthy();
  const order = [...view.container.querySelectorAll("section[aria-label]")].map(
    (section) => section.getAttribute("aria-label"),
  );
  expect(order.indexOf("Ready for review")).toBeLessThan(
    order.indexOf("Working"),
  );
});
