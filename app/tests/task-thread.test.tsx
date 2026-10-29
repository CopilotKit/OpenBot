import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import type { Message } from "@ag-ui/core";
import { frameTaskBrief } from "@openbot/shared/task-brief";
import { CopilotKitProvider } from "@copilotkit/react-core/v2";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClientProvider } from "@tanstack/react-query";
import {
  type AnyRoute,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BotActivityGlance } from "@/components/bot-profile/activity";
import { ChannelWorkRows } from "@/components/channels/channel-work";
import { TaskPage } from "@/components/tasks/task-page";
import { queryClient } from "@/query-client";
import { Route as ChannelRoute } from "@/routes/_authed/_app/channel/$channelId";
import { settleReactWork } from "./settle-react-work";

const defaults = queryClient.getDefaultOptions();

/**
 * A task's page, through the real conversation: the provider, the agent, the
 * transcript and the composer are real, and only `fetch` is a fixture.
 *
 * The page is the task's own conversation with its report above it. A reply goes to the server,
 * which queues it behind whatever the task is doing, so nothing typed there runs in the browser.
 * A task that couldn't finish has Try again, and takes a reply as Try again with the person's words.
 * A task's conversation reached as a conversation, from a link anywhere, opens as the task.
 */

const NativeResponse = globalThis.Response;
const originalFetch = globalThis.fetch;
const originalSocket = globalThis.WebSocket;

class QuietSocket {
  onopen: unknown = null;
  onclose: unknown = null;
  onmessage: unknown = null;
  onerror: unknown = null;
  readyState = 0;
  close() {}
  send() {}
}

const ago = (minutes: number) =>
  new Date(Date.now() - minutes * 60_000).toISOString();

type Task = Record<string, unknown> & { id: string; status: string };
const task = (overrides: Partial<Task> = {}): Task => ({
  id: "t-1",
  botId: "scout",
  channelId: "task-channel",
  threadId: "task-thread",
  title: "Find a time for coffee with Sam",
  why: null,
  origin: "asked",
  suggestionId: null,
  sourceApp: null,
  sourceLink: null,
  status: "ready_for_review",
  failure: null,
  failedAt: null,
  next: "I booked Tuesday at 10.",
  queuedReplies: [],
  answeredQuestionIds: [],
  resolvedAt: null,
  createdAt: ago(60),
  updatedAt: ago(5),
  ...overrides,
});

let current: Task;
let history: Message[];
let report: unknown;
let sent: { method: string; path: string; body: unknown }[];
let runs: string[];
/** What a write answers with, by path; anything else answers with the current task. */
let writes: Record<string, { status: number; body: unknown }>;
/** Reads that fail for now, by path, as a server that stopped answering would. */
let down: Set<string>;
/** Scout's activity, as its Bot page reads it. */
let activity: unknown;

function sse(events: unknown[]) {
  return new NativeResponse(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
}

const channelOf = (id: string, threadId: string) => ({
  id,
  name: id,
  agentIds: ["scout"],
  threadId,
  active: true,
  lastMessageAt: ago(5),
});

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost:3010" });
  globalThis.WebSocket = QuietSocket as unknown as typeof WebSocket;
  // Failures answer at once here; the app's own defaults come back after this file.
  queryClient.setDefaultOptions({
    queries: { ...defaults.queries, retry: false },
  });
  globalThis.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = new URL(
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url,
        "http://localhost",
      );
      const path = url.pathname;
      const method =
        init?.method ?? (input instanceof Request ? input.method : "GET");
      if (path.endsWith("/info"))
        return NativeResponse.json({
          version: "fixture",
          agents: { scout: { description: "Fixture", capabilities: {} } },
          mode: "sse",
          telemetryDisabled: true,
        });
      if (path.endsWith("/connect"))
        return sse([
          { type: "RUN_STARTED", threadId: "x", runId: "join" },
          { type: "MESSAGES_SNAPSHOT", messages: [] },
          { type: "RUN_FINISHED", threadId: "x", runId: "join" },
        ]);
      if (path.endsWith("/run")) {
        runs.push(path);
        return sse([]);
      }
      if (/\/threads\/[^/]+\/messages$/.test(path))
        return NativeResponse.json({ messages: history });
      if (down.has(path))
        return NativeResponse.json(
          { error: "Service unavailable" },
          { status: 503 },
        );
      if (method !== "GET") {
        const body = init?.body ? JSON.parse(String(init.body)) : null;
        sent.push({ method, path, body });
        const answer = writes[path];
        if (answer)
          return NativeResponse.json(answer.body, { status: answer.status });
        return NativeResponse.json({ task: current });
      }
      if (path === "/api/agents")
        return NativeResponse.json({
          agents: [{ id: "scout", name: "Scout", avatarSeed: "scout" }],
        });
      if (path === "/api/tasks")
        return NativeResponse.json({ tasks: [current] });
      if (path === `/api/tasks/${current.id}`)
        return NativeResponse.json({ task: current });
      if (path === `/api/tasks/${current.id}/report`)
        return NativeResponse.json({ report });
      if (path === "/api/tasks/missing")
        return NativeResponse.json(
          { error: "Couldn't find that task." },
          { status: 404 },
        );
      if (path === "/api/channels/task-channel")
        return NativeResponse.json({
          channel: {
            ...channelOf("task-channel", "task-thread"),
            taskId: "t-1",
          },
        });
      if (path === "/api/bots/scout/activity")
        return NativeResponse.json({ activity });
      if (path === "/api/channels")
        return NativeResponse.json({ channels: [], nextCursor: null });
      if (path === "/api/approvals")
        return NativeResponse.json({
          enabled: true,
          rules: [],
          teamRules: [],
          requests: [],
          questions: [],
        });
      if (path === "/api/voice/sessions")
        return NativeResponse.json({ sessions: [], nextCursor: null });
      return NativeResponse.json({ error: "not served" }, { status: 404 });
    },
    { preconnect() {} },
  );
});
afterEach(() => {
  cleanup();
  queryClient.clear();
});
afterAll(async () => {
  await settleReactWork();
  queryClient.setDefaultOptions(defaults);
  globalThis.fetch = originalFetch;
  globalThis.WebSocket = originalSocket;
  GlobalRegistrator.unregister();
});

function setUp(overrides: Partial<Task> = {}) {
  current = task(overrides);
  history = [
    {
      id: "task-t-1",
      role: "user",
      content: frameTaskBrief("Find a time for coffee with Sam next week."),
    },
    { id: "a-1", role: "assistant", content: "I booked Tuesday at 10." },
  ];
  report = {
    taskId: "t-1",
    entries: [
      {
        kind: "update",
        id: "u-1",
        text: "I found three free slots.",
        at: ago(30),
      },
      {
        kind: "decision",
        id: "d-1",
        decision: "allow_once",
        by: "you",
        at: ago(20),
        action: {
          toolRef: "mcp/gmail/send_email",
          effect: "write",
          scope: "sam@example.com",
          args: { to: "sam@example.com" },
        },
      },
      { kind: "reply", id: "r-1", text: "Make it 20 minutes.", at: null },
    ],
  };
  sent = [];
  runs = [];
  writes = {};
  down = new Set();
  activity = { inProgress: [], scheduled: [], completed: [] };
}

/** The app around a page: the router, the cache and the CopilotKit runtime. */
function drawAt(path: string, page: () => React.ReactNode) {
  const root = createRootRoute({
    component: () => (
      <CopilotKitProvider runtimeUrl="http://localhost/api/copilotkit">
        <Outlet />
      </CopilotKitProvider>
    ),
  });
  const here = createRoute({
    getParentRoute: () => root,
    path: "/here",
    component: page,
  });
  const tasks = createRoute({
    getParentRoute: () => root,
    path: "/tasks",
    component: () => <p>Tasks list</p>,
  });
  const opened = createRoute({
    getParentRoute: () => root,
    path: "/tasks/$taskId",
    component: function Opened() {
      const { taskId } = opened.useParams() as { taskId: string };
      return <p>Opened {taskId}</p>;
    },
  });
  const router = createRouter({
    routeTree: root.addChildren([here, tasks, opened]),
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
  return { view, router, user: userEvent.setup({ document }) };
}

const drawTask = (taskId = "t-1") =>
  drawAt("/here", () => <TaskPage taskId={taskId} />);

test("the task page reads its title and where it stands, how it began, its report, then its conversation in the person's own words", async () => {
  setUp({ origin: "suggestion", why: "Sam asked last week" });
  const { view } = drawTask();
  expect(
    await view.findByRole("heading", {
      name: "Find a time for coffee with Sam",
    }),
  ).toBeTruthy();
  expect(view.getByText("Ready for review").getAttribute("data-status")).toBe(
    "ready_for_review",
  );
  expect(
    view.getByText(/^Suggested today at .* · Sam asked last week$/),
  ).toBeTruthy();
  const updates = await view.findByRole("list", {
    name: "Decisions and updates",
  });
  expect(
    within(updates)
      .getAllByRole("listitem")
      .map((item) => item.getAttribute("data-entry")),
  ).toEqual(["update", "decision", "reply"]);
  expect(
    within(updates).getByText(
      "Allowed once: Send your email to sam@example.com",
    ),
  ).toBeTruthy();
  // The ask under its frame is the person's own words; the frame never shows.
  expect(
    await view.findByText("Find a time for coffee with Sam next week."),
  ).toBeTruthy();
  expect(view.queryByText(/This conversation is a task/)).toBeNull();
  expect(view.getByRole("button", { name: "Mark done" })).toBeTruthy();
  expect(view.queryByRole("button", { name: "Try again" })).toBeNull();
});

test("a reply steers the task through the server: drawn at once under its id, never run in the browser", async () => {
  setUp();
  const { view, user } = drawTask();
  await view.findByText("Find a time for coffee with Sam next week.");
  const box = await view.findByRole("textbox", { name: "Message" });
  // An ordinary reply carries files as any message does.
  expect(await view.findByLabelText("Attach a file")).toBeTruthy();
  await user.type(box, "Make it Wednesday instead");
  await user.click(view.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(sent).toHaveLength(1));
  const [reply] = sent;
  expect(reply?.path).toBe("/api/tasks/t-1/reply");
  expect(reply?.body).toMatchObject({ reply: "Make it Wednesday instead" });
  const messageId = (reply?.body as { messageId?: string } | undefined)
    ?.messageId;
  expect(messageId).toMatch(/^[A-Za-z0-9-]{8,64}$/);
  expect(await view.findByText("Make it Wednesday instead")).toBeTruthy();
  expect(runs).toEqual([]);
});

test("replies the server holds are drawn as Queued while the task's turn runs, and Stop is not offered", async () => {
  setUp({
    status: "working",
    next: "“Make it shorter”",
    queuedReplies: [{ messageId: "held-1", text: "Make it shorter" }],
  });
  const { view } = drawTask();
  expect(await view.findByText("Make it shorter")).toBeTruthy();
  expect(view.getByText("Queued")).toBeTruthy();
  expect(view.getByText("Working").getAttribute("data-status")).toBe("working");
  expect(view.queryByRole("button", { name: /Stop/ })).toBeNull();
  // Taken by the server, so nothing here can take it back.
  expect(
    view.queryByRole("button", { name: /Remove queued message/ }),
  ).toBeNull();
});

test("Mark done and Reopen", async () => {
  setUp();
  const { view, user } = drawTask();
  await user.click(await view.findByRole("button", { name: "Mark done" }));
  await waitFor(() =>
    expect(sent).toContainEqual({
      method: "POST",
      path: "/api/tasks/t-1/resolve",
      body: null,
    }),
  );
  cleanup();
  queryClient.clear();
  setUp({ status: "resolved", resolvedAt: ago(1) });
  const again = drawTask();
  await again.user.click(
    await again.view.findByRole("button", { name: "Reopen" }),
  );
  await waitFor(() =>
    expect(sent).toContainEqual({
      method: "POST",
      path: "/api/tasks/t-1/reopen",
      body: null,
    }),
  );
});

test("a task that couldn't finish says why, and Try again runs it once more", async () => {
  setUp({
    status: "failed",
    failure: "a service didn't answer",
    failedAt: ago(2),
    next: null,
  });
  const { view, user } = drawTask();
  expect(
    await view.findByText("Couldn't finish: a service didn't answer."),
  ).toBeTruthy();
  expect(view.getByText(/reply and Scout runs it again/)).toBeTruthy();
  await user.click(view.getByRole("button", { name: "Try again" }));
  await waitFor(() =>
    expect(sent).toContainEqual({
      method: "POST",
      path: "/api/tasks/t-1/again",
      body: {},
    }),
  );
});

test("a reply typed on a failed task runs it again with the person's words, and waits its turn if it was already started", async () => {
  setUp({ status: "failed", failure: "a service didn't answer", next: null });
  writes = {
    "/api/tasks/t-1/again": {
      status: 409,
      body: { error: "This task is already being tried again." },
    },
  };
  const { view, user } = drawTask();
  await view.findByText("Couldn't finish: a service didn't answer.");
  // Words only: there is nothing to attach while the reply tries the task again.
  expect(
    await view.findByLabelText("More message options unavailable"),
  ).toBeTruthy();
  expect(view.queryByLabelText("Attach a file")).toBeNull();
  await user.type(
    await view.findByRole("textbox", { name: "Message" }),
    "Try the other kiln shop",
  );
  await user.click(view.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(sent).toHaveLength(2));
  const [again, reply] = sent;
  expect(again?.path).toBe("/api/tasks/t-1/again");
  expect(again?.body).toMatchObject({ reply: "Try the other kiln shop" });
  expect(reply?.path).toBe("/api/tasks/t-1/reply");
  const idOf = (body: unknown) => (body as { messageId?: string }).messageId;
  expect(idOf(reply?.body)).toBe(idOf(again?.body));
  expect(idOf(again?.body)).toBeTruthy();
  // The reply was taken, so nothing failed.
  expect(view.queryByRole("alert")).toBeNull();
});

test("a reply the server refuses says why and goes back in the box", async () => {
  setUp();
  writes = {
    "/api/tasks/t-1/reply": {
      status: 409,
      body: { error: "This task is no longer available to you." },
    },
  };
  const { view, user } = drawTask();
  await view.findByText("Find a time for coffee with Sam next week.");
  const box = await view.findByRole("textbox", { name: "Message" });
  await user.type(box, "One more thing");
  await user.click(view.getByRole("button", { name: "Send message" }));
  expect((await view.findByRole("alert")).textContent).toBe(
    "This task is no longer available to you.",
  );
  await waitFor(() => expect(box.textContent).toContain("One more thing"));
  expect(view.queryByText("One more thing", { selector: "span" })).toBeNull();
});

test("a task that isn't the person's, or is gone, says it couldn't be opened", async () => {
  setUp();
  const { view } = drawTask("missing");
  expect((await view.findByRole("alert")).textContent).toBe(
    "Couldn't open this task. Go back to Tasks and try again.",
  );
});

test("a refresh that fails keeps the task open with its report and what was typed, and says it couldn't refresh", async () => {
  setUp();
  const { view, user } = drawTask();
  await view.findByText("Find a time for coffee with Sam next week.");
  await view.findByRole("list", { name: "Decisions and updates" });
  const box = await view.findByRole("textbox", { name: "Message" });
  await user.type(box, "Half a thought");
  down = new Set([
    "/api/tasks/t-1",
    "/api/tasks/t-1/report",
    "/api/channels/task-channel",
  ]);
  // The page's own reads again: the task, its report and its conversation.
  await Promise.all([
    queryClient.refetchQueries({ queryKey: ["tasks"] }),
    queryClient.refetchQueries({ queryKey: ["channels", "detail"] }),
  ]);
  expect(
    await view.findByText("Couldn't refresh this task. Reload the page."),
  ).toBeTruthy();
  expect(
    view.getByRole("heading", { name: "Find a time for coffee with Sam" }),
  ).toBeTruthy();
  expect(
    view.getByRole("list", { name: "Decisions and updates" }),
  ).toBeTruthy();
  expect(view.queryByRole("alert")).toBeNull();
  expect(box.isConnected).toBe(true);
  expect(box.textContent).toContain("Half a thought");
});

test("a task's conversation opened as a conversation opens as the task, and Back goes to where it was opened from", async () => {
  setUp({ status: "needs_input" });
  const root = createRootRoute({
    component: () => (
      <CopilotKitProvider runtimeUrl="http://localhost/api/copilotkit">
        <Outlet />
      </CopilotKitProvider>
    ),
  });
  const authed = createRoute({
    id: "_authed",
    getParentRoute: () => root,
    component: Outlet,
  });
  const app = createRoute({
    id: "_app",
    getParentRoute: () => authed,
    component: Outlet,
  });
  const bot = createRoute({
    getParentRoute: () => app,
    path: "bots",
    component: () => <p>Scout's page</p>,
  });
  const channel = createRoute({
    getParentRoute: () => app,
    path: "channel/$channelId",
    component: (ChannelRoute as AnyRoute).options.component,
    validateSearch: (ChannelRoute as AnyRoute).options.validateSearch,
  });
  const opened = createRoute({
    getParentRoute: () => app,
    path: "tasks/$taskId",
    component: function Opened() {
      const { taskId } = opened.useParams() as { taskId: string };
      return <p>Opened {taskId}</p>;
    },
  });
  const router = createRouter({
    routeTree: root.addChildren([
      authed.addChildren([app.addChildren([bot, channel, opened])]),
    ]),
    history: createMemoryHistory({ initialEntries: ["/bots"] }),
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
  await view.findByText("Scout's page");
  await router.navigate({
    to: "/channel/$channelId",
    params: { channelId: "task-channel" },
  } as never);
  expect(await view.findByText("Opened t-1")).toBeTruthy();
  expect(router.state.location.pathname).toBe("/tasks/t-1");
  expect(view.queryByRole("textbox", { name: "Message" })).toBeNull();
  expect(runs).toEqual([]);
  router.history.back();
  await waitFor(() => expect(router.state.location.pathname).toBe("/bots"));
});

test("on a Bot's page, what was raised in a task opens the task, and the rest opens its conversation", async () => {
  setUp({ status: "needs_input" });
  const row = (id: string, kind: string, channelId: string) => ({
    id,
    kind,
    title: id,
    detail: null,
    status: "pending",
    at: ago(1),
    channelId,
    needsYou: true,
    stoppable: false,
    cancellable: false,
  });
  activity = {
    inProgress: [
      row("Send the invite", "approval", "task-channel"),
      row("Which deck?", "question", "chat"),
    ],
    scheduled: [],
    completed: [],
  };
  const { view } = drawAt("/here", () => <BotActivityGlance agentId="scout" />);
  const inTask = await view.findByRole("link", { name: /Send the invite/ });
  await waitFor(() => expect(inTask.getAttribute("href")).toBe("/tasks/t-1"));
  expect(
    view.getByRole("link", { name: /Which deck\?/ }).getAttribute("href"),
  ).toBe("/channel/chat");
});

test("a task's turn running on the server reads as the Bot working on it, never as a routine", () => {
  const view = render(
    <ChannelWorkRows
      botOf={() => ({ name: "Scout", avatarSeed: "scout" })}
      work={[
        {
          kind: "task",
          key: "w-1",
          taskId: "t-1",
          botId: "scout",
          botName: "Scout",
          since: ago(1),
        },
      ]}
    />,
  );
  expect(view.getByText("Scout is working on it…")).toBeTruthy();
  expect(view.queryByText(/routine/)).toBeNull();
});
