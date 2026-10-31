import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AppSidebar } from "@/components/app-sidebar/app-sidebar";
import { SidebarProvider } from "@/components/ui/sidebar";
import { authKeys } from "@/lib/auth/queries";
import { queryClient } from "@/query-client";
import { Route as TasksRoute } from "@/routes/_authed/_app/tasks";
import { settleReactWork } from "./settle-react-work";

const defaults = queryClient.getDefaultOptions();

/**
 * Tasks: the list beside the open task. Every task is grouped by what it needs, Needs you first and
 * Done folded; each row is its Bot's orb, its title and what it needs next, and opens the task.
 * Up next under it holds the Bots' open suggestions. The keyboard moves through the list, opens a
 * task and closes it again. The + starts a task with a Bot of the person's choosing. And the
 * sidebar's Tasks entry counts what needs the person, while a task's own conversation stays out of
 * the conversation list.
 *
 * The task's own page is stubbed here (`task-thread.test.tsx` draws it), so this file is the list.
 */

class QuietSocket {
  onopen: unknown = null;
  onclose: unknown = null;
  onmessage: unknown = null;
  onerror: unknown = null;
  readyState = 0;
  close() {}
  send() {}
}

const originalFetch = globalThis.fetch;
const originalSocket = globalThis.WebSocket;
beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost:3010" });
  globalThis.WebSocket = QuietSocket as unknown as typeof WebSocket;
  // Failures answer at once here; the app's own defaults come back after this file.
  queryClient.setDefaultOptions({
    queries: { ...defaults.queries, retry: false },
  });
});
afterEach(() => {
  cleanup();
  queryClient.clear();
  globalThis.fetch = originalFetch;
});
afterAll(async () => {
  await settleReactWork();
  queryClient.setDefaultOptions(defaults);
  globalThis.WebSocket = originalSocket;
  GlobalRegistrator.unregister();
});

const ago = (minutes: number) =>
  new Date(Date.now() - minutes * 60_000).toISOString();

const task = (overrides: Record<string, unknown> & { id: string }) => ({
  botId: "scout",
  channelId: `${overrides.id}-channel`,
  threadId: `${overrides.id}-thread`,
  title: overrides.id,
  why: null,
  origin: "asked",
  suggestionId: null,
  sourceApp: null,
  sourceLink: null,
  status: "working",
  failure: null,
  failedAt: null,
  next: null,
  queuedReplies: [],
  answeredQuestionIds: [],
  resolvedAt: null,
  createdAt: ago(120),
  updatedAt: ago(120),
  ...overrides,
});

const suggestion = (overrides: Record<string, unknown> & { id: string }) => ({
  agentId: "ana",
  title: "Confirm Friday's ship date",
  detail: "Ana asked for a date by the end of the day.",
  sourceApp: "Gmail",
  sourceLink: null,
  createdAt: ago(30),
  ...overrides,
});

const conversation = (overrides: Record<string, unknown> & { id: string }) => ({
  name: overrides.id,
  agentIds: ["scout"],
  threadId: `${overrides.id}-thread`,
  active: true,
  lastMessageAt: ago(10),
  summary: null,
  lastMessage: "Hello",
  lastMessageAgentId: null,
  createdAt: ago(100),
  pinned: false,
  lastReadAt: null,
  taskId: null,
  ...overrides,
});

type Served = {
  tasks?: unknown[] | "error";
  suggestions?: unknown[];
  inbox?: { requests: unknown[]; questions: unknown[] };
  channels?: unknown[];
  /** What a write answers with, by path. */
  writes?: Record<string, { status: number; body: unknown }>;
};

function serve(served: Served = {}) {
  const sent: { method: string; path: string; body: unknown }[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input).split("?")[0] ?? "";
    const method = init?.method ?? "GET";
    if (method !== "GET") {
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      sent.push({ method, path, body });
      const answer = served.writes?.[path];
      return answer
        ? Response.json(answer.body, { status: answer.status })
        : Response.json({ ok: true });
    }
    if (path === "/api/tasks")
      return served.tasks === "error"
        ? Response.json({ error: "Couldn't load your tasks." }, { status: 503 })
        : Response.json({ tasks: served.tasks ?? [] });
    if (path === "/api/proactive/suggestions")
      return Response.json({ suggestions: served.suggestions ?? [] });
    if (path === "/api/approvals")
      return Response.json({
        enabled: true,
        rules: [],
        teamRules: [],
        requests: [],
        questions: [],
        ...served.inbox,
      });
    if (path === "/api/agents")
      return Response.json({
        agents: [
          { id: "scout", name: "Scout", avatarSeed: "scout" },
          { id: "ana", name: "Ana", avatarSeed: "ana" },
        ],
      });
    if (path === "/api/channels")
      return Response.json({
        channels: served.channels ?? [],
        nextCursor: null,
      });
    return Response.json({ error: "not served" }, { status: 404 });
  }) as unknown as typeof fetch;
  return sent;
}

/** Tasks as `_authed/_app` serves it: the list column, and a stand-in for the open task. */
function draw(path = "/tasks") {
  const root = createRootRoute();
  const tasks = createRoute({
    getParentRoute: () => root,
    path: "/tasks",
    component: TasksRoute.options.component,
  });
  const none = createRoute({
    getParentRoute: () => tasks,
    path: "/",
    component: () => <p>No task open</p>,
  });
  const open = createRoute({
    getParentRoute: () => tasks,
    path: "$taskId",
    component: function OpenTask() {
      const { taskId } = open.useParams();
      return <h2>Open task {taskId}</h2>;
    },
  });
  const router = createRouter({
    routeTree: root.addChildren([tasks.addChildren([none, open])]),
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
  return { view, router, user: userEvent.setup({ document }) };
}

const groupNames = (view: ReturnType<typeof render>) =>
  view
    .getAllByRole("region")
    .map((region) => region.querySelector("h2")?.textContent);

const rows = () =>
  [...document.querySelectorAll<HTMLElement>("[data-task-row]")].map(
    (row) => row.dataset.taskId,
  );

const everyState = [
  task({
    id: "done",
    title: "Send the invoice",
    status: "resolved",
    resolvedAt: ago(5),
  }),
  task({
    id: "read",
    title: "Summarise the launch feedback",
    status: "ready_for_review",
    next: "I grouped it into three themes.",
  }),
  task({
    id: "broke",
    title: "Book the kiln repair",
    status: "failed",
    failure: "a service didn't answer",
  }),
  task({ id: "run", title: "Draft the Q4 summary", status: "working" }),
  task({
    id: "ask",
    title: "Reply to Rosa",
    status: "needs_input",
    next: "Should I mention the price change?",
    botId: "ana",
  }),
];

test("Tasks groups every task by what it needs, Needs you first, with Done folded until its heading is pressed", async () => {
  serve({ tasks: everyState });
  const { view } = draw();
  await view.findByText("Reply to Rosa");
  expect(groupNames(view)).toEqual([
    "Needs you1",
    "Working1",
    "Failed1",
    "Ready for review1",
    "Done1",
  ]);
  expect(rows()).toEqual(["ask", "run", "broke", "read"]);
  // What each one needs next, under its title.
  expect(view.getByText("Should I mention the price change?")).toBeTruthy();
  expect(view.getByText("Just started")).toBeTruthy();
  expect(
    view.getByText("Couldn't finish: a service didn't answer."),
  ).toBeTruthy();
  expect(view.getByText("I grouped it into three themes.")).toBeTruthy();
  // Each row wears its Bot's orb, named for the Bot.
  const rosa = view.getByRole("link", { name: /Reply to Rosa/ });
  expect(within(rosa).getByRole("img", { name: "Ana" })).toBeTruthy();

  const done = view.getByRole("button", { name: /^Done/ });
  expect(done.getAttribute("aria-expanded")).toBe("false");
  expect(view.queryByText("Send the invoice")).toBeNull();
  fireEvent.click(done);
  expect(await view.findByText("Send the invoice")).toBeTruthy();
  expect(done.getAttribute("aria-expanded")).toBe("true");
});

test("a row opens its task beside the list, and is lit while it is open", async () => {
  serve({ tasks: everyState });
  const { view, router, user } = draw();
  expect(await view.findByText("No task open")).toBeTruthy();
  await user.click(view.getByRole("link", { name: /Draft the Q4 summary/ }));
  expect(
    await view.findByRole("heading", { name: "Open task run" }),
  ).toBeTruthy();
  expect(router.state.location.pathname).toBe("/tasks/run");
  expect(
    view
      .getByRole("link", { name: /Draft the Q4 summary/ })
      .getAttribute("aria-current"),
  ).toBe("page");
});

test("a done task opened from elsewhere keeps Done unfolded, so its row is in view", async () => {
  serve({ tasks: everyState });
  const { view } = draw("/tasks/done");
  expect(await view.findByText("Send the invoice")).toBeTruthy();
});

test("the keyboard moves through the list with ↓ ↑ and j k, Enter opens a task and Escape closes it on its row", async () => {
  serve({ tasks: everyState });
  const { view, router, user } = draw();
  await view.findByText("Reply to Rosa");
  // With nothing focused, j puts the focus in the list.
  await user.keyboard("j");
  expect(document.activeElement?.getAttribute("data-task-id")).toBe("ask");
  await user.keyboard("j");
  expect(document.activeElement?.getAttribute("data-task-id")).toBe("run");
  await user.keyboard("{ArrowDown}");
  expect(document.activeElement?.getAttribute("data-task-id")).toBe("broke");
  await user.keyboard("k");
  await user.keyboard("{ArrowUp}");
  expect(document.activeElement?.getAttribute("data-task-id")).toBe("ask");
  // The first row stays put going up.
  await user.keyboard("k");
  expect(document.activeElement?.getAttribute("data-task-id")).toBe("ask");

  await user.keyboard("{ArrowDown}{Enter}");
  expect(
    await view.findByRole("heading", { name: "Open task run" }),
  ).toBeTruthy();
  await user.keyboard("{Escape}");
  await waitFor(() => expect(router.state.location.pathname).toBe("/tasks"));
  await waitFor(() =>
    expect(document.activeElement?.getAttribute("data-task-id")).toBe("run"),
  );
});

test("the list's keys leave someone typing alone", async () => {
  serve({ tasks: everyState });
  const { view, router, user } = draw("/tasks/run");
  await view.findByRole("heading", { name: "Open task run" });
  const field = document.createElement("textarea");
  document.body.append(field);
  field.focus();
  await user.keyboard("jk{Escape}");
  expect(field.value).toBe("jk");
  expect(router.state.location.pathname).toBe("/tasks/run");
  field.remove();
});

test("with no tasks and nothing up next, Tasks says how tasks arrive", async () => {
  serve();
  const { view } = draw();
  expect(await view.findByText("No tasks yet")).toBeTruthy();
  expect(view.getByText(/Start one with New task/)).toBeTruthy();
});

test("a list that couldn't load says so", async () => {
  serve({ tasks: "error" });
  const { view } = draw();
  expect((await view.findByRole("alert")).textContent).toBe(
    "Couldn't load your tasks. Reload the page.",
  );
});

test("a refresh of the list that fails keeps the tasks on screen, and says it couldn't refresh", async () => {
  serve({ tasks: everyState });
  const { view } = draw("/tasks/run");
  await view.findByText("Reply to Rosa");
  serve({ tasks: "error" });
  await queryClient.refetchQueries({ queryKey: ["tasks", "list"] });
  expect(
    await view.findByText("Couldn't refresh your tasks. Reload the page."),
  ).toBeTruthy();
  expect(rows()).toEqual(["ask", "run", "broke", "read"]);
  expect(view.queryByRole("alert")).toBeNull();
  expect(view.getByRole("heading", { name: "Open task run" })).toBeTruthy();
});

test("Up next lists the Bots' open suggestions: Start opens the task it started, Dismiss puts one away", async () => {
  const sent = serve({
    tasks: [task({ id: "run", status: "working" })],
    suggestions: [
      suggestion({ id: "s-1", title: "Confirm Friday's ship date" }),
      suggestion({
        id: "s-2",
        title: "Chase the overdue invoice",
        agentId: "scout",
        sourceApp: null,
      }),
    ],
    writes: {
      "/api/proactive/suggestions/s-1/start": {
        status: 200,
        body: {
          suggestion: { id: "s-1" },
          task: { id: "from-s-1", channelId: "c", title: "Confirm" },
        },
      },
    },
  });
  const { view, router } = draw();
  const upNext = await view.findByRole("region", { name: /Up next/ });
  expect(within(upNext).getByText("Ana · From Gmail")).toBeTruthy();
  expect(within(upNext).getByText("Scout")).toBeTruthy();

  fireEvent.click(
    within(upNext).getByRole("button", {
      name: "Dismiss Chase the overdue invoice",
    }),
  );
  await waitFor(() =>
    expect(sent).toContainEqual({
      method: "POST",
      path: "/api/proactive/suggestions/s-2/dismiss",
      body: null,
    }),
  );
  fireEvent.click(
    within(upNext).getByRole("button", {
      name: "Start Confirm Friday's ship date",
    }),
  );
  await waitFor(() =>
    expect(router.state.location.pathname).toBe("/tasks/from-s-1"),
  );
  expect(sent).toContainEqual({
    method: "POST",
    path: "/api/proactive/suggestions/s-1/start",
    body: null,
  });
});

test("the + asks which Bot and what to do, starts with the default Bot, and opens the task it started", async () => {
  const sent = serve({
    tasks: [],
    writes: {
      "/api/tasks": {
        status: 201,
        body: { task: task({ id: "new-1", title: "Find a time" }) },
      },
    },
  });
  const { view, router, user } = draw();
  await view.findByText("No tasks yet");
  await user.click(view.getByRole("button", { name: "New task" }));
  const dialog = await view.findByRole("dialog", { name: "New task" });
  // The person's default Bot, until they choose another.
  await waitFor(() =>
    expect(within(dialog).getByRole("combobox").textContent).toContain("Scout"),
  );
  const start = within(dialog).getByRole("button", { name: "Start task" });
  expect(start.hasAttribute("disabled")).toBe(true);
  await user.type(
    within(dialog).getByRole("textbox", { name: "What should it do?" }),
    "  Find a time for coffee with Sam.  ",
  );
  await user.click(start);
  await waitFor(() =>
    expect(router.state.location.pathname).toBe("/tasks/new-1"),
  );
  expect(sent).toEqual([
    {
      method: "POST",
      path: "/api/tasks",
      body: { botId: "scout", instruction: "Find a time for coffee with Sam." },
    },
  ]);
  await waitFor(() => expect(view.queryByRole("dialog")).toBeNull());
});

test("a task the server refuses keeps the dialog open with the server's words", async () => {
  serve({
    writes: {
      "/api/tasks": {
        status: 404,
        body: { error: "Couldn't find that Bot. Reload the page." },
      },
    },
  });
  const { view, user } = draw();
  await view.findByText("No tasks yet");
  await user.click(view.getByRole("button", { name: "New task" }));
  const dialog = await view.findByRole("dialog", { name: "New task" });
  await user.type(
    within(dialog).getByRole("textbox", { name: "What should it do?" }),
    "Do it",
  );
  await user.keyboard("{Meta>}{Enter}{/Meta}");
  expect((await within(dialog).findByRole("alert")).textContent).toBe(
    "Couldn't find that Bot. Reload the page.",
  );
  expect(within(dialog).getByRole<HTMLTextAreaElement>("textbox").value).toBe(
    "Do it",
  );
});

test("the sidebar has Tasks above Bots with how many need you, and keeps tasks' conversations out of its list", async () => {
  serve({
    tasks: [
      task({ id: "ask", status: "needs_input" }),
      task({ id: "held", status: "working", threadId: "held-thread" }),
      task({ id: "run", status: "working" }),
    ],
    inbox: {
      // An approval waiting in a task's own conversation makes it need you too.
      requests: [
        {
          id: "r-1",
          status: "pending",
          createdAt: ago(1),
          action: {
            botId: "scout",
            toolRef: "mcp/gmail/send_email",
            effect: "write",
            scope: "x",
            threadId: "held-thread",
            args: {},
            target: {},
          },
        },
      ],
      questions: [],
    },
    channels: [
      conversation({ id: "chat", name: "Weekend plans" }),
      conversation({ id: "ask-channel", name: "Reply to Rosa", taskId: "ask" }),
    ],
  });
  queryClient.setQueryData(authKeys.currentUser(), {
    id: "maya",
    name: "Maya Chen",
    email: "maya@example.com",
    role: "user",
    onboarding: null,
  });
  const root = createRootRoute({
    component: () => (
      <SidebarProvider>
        <AppSidebar />
      </SidebarProvider>
    ),
  });
  const router = createRouter({
    routeTree: root,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
  expect(await view.findByText("Weekend plans")).toBeTruthy();
  expect(view.queryByText("Reply to Rosa")).toBeNull();
  const footer = view.container.querySelector<HTMLElement>(
    '[data-sidebar="footer"]',
  );
  if (!footer) throw new Error("No sidebar footer");
  const labels = within(footer)
    .getAllByRole("link")
    .map((link) => link.getAttribute("href"));
  expect(labels.indexOf("/tasks")).toBe(labels.indexOf("/bots") - 1);
  const tasksLink = within(footer).getByRole("link", { name: /Tasks/ });
  expect(
    (await within(tasksLink).findByRole("img", { name: "2 things need you" }))
      .textContent,
  ).toBe("2");
  await act(async () => {});
});
