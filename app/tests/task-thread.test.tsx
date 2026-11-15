import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  environmentManager,
  focusManager,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import type { ReactNode } from "react";
import { Streamdown } from "streamdown";
import {
  MessageReactions,
  SentFromBot,
  TaskCard,
  TaskReport,
  ThreadLinks,
} from "@/components/tasks/task-thread";
import { refreshTaskCards } from "@/lib/channels/use-channel-events";
import { inAppPath, markdownComponents } from "@/lib/markdown";
import { settleReactWork } from "./settle-react-work";

/**
 * What a Bot's task threads draw in the conversation that asked for them: the task's card, which
 * reads the task and turns Needs you or Done in place; the line a task says when it needs the person,
 * with the way into its thread; the result's link; and the Bot's reaction under a message, read
 * through the client generated from api/openapi.yaml.
 *
 * The server is faked at the HTTP boundary only, answering where today's server answers.
 */

/** What the task waits for, as its needs-you line says it. */
const WAITING =
  "Waiting for your approval: click the button “Place order” on shop.example";

let task = {
  id: "task-1",
  botId: "general-assistant",
  conversationId: "channel_task",
  threadId: "thread_task",
  title: "Order heirloom tomato seeds",
  why: null,
  origin: "delegated",
  suggestionId: null,
  sourceApp: null,
  sourceLink: null,
  originConversationId: "channel_main",
  status: "needs_input",
  failure: null as string | null,
  failedAt: null as string | null,
  stoppedAt: null as string | null,
  workingSince: null as string | null,
  lastActivityAt: "2026-11-12T22:00:00.000Z",
  next: WAITING as string | null,
  resolvedAt: null,
  createdAt: "2026-11-12T22:00:00.000Z",
  updatedAt: "2026-11-12T22:00:00.000Z",
};
const requests: string[] = [];
const server = setupServer(
  // Tasks and reactions, at the API's addresses and in its shapes, as the server answers them.
  http.get("*/api/v2/organizations/:organizationId/tasks/:id", ({ params }) =>
    params.id === task.id
      ? HttpResponse.json({ task })
      : HttpResponse.json(
          {
            type: "https://open.bot/errors/not-found",
            title: "Not found.",
            status: 404,
            detail: "Couldn't find that task.",
            code: "NOT_FOUND",
            category: "not_found",
            retryable: false,
            requestId: "req_test",
            traceId: "trace_test",
          },
          {
            status: 404,
            headers: { "content-type": "application/problem+json" },
          },
        ),
  ),
  http.get("*/api/v2/organizations/:organizationId/reactions", ({ request }) =>
    HttpResponse.json({
      nextCursor: null,
      reactions:
        new URL(request.url).searchParams.get("threadId") === "thread_main"
          ? [
              {
                messageId: "message-thanks",
                agentId: "general-assistant",
                emoji: "👍",
                createdAt: "2026-11-12T22:01:00.000Z",
              },
            ]
          : [],
    }),
  ),
  // The task list, which the brief finds its task in by thread.
  http.get("*/api/v2/organizations/:organizationId/tasks", () =>
    HttpResponse.json({ tasks: [task], nextCursor: null }),
  ),
  // The Bots list, at the API's address and in its shape, as the server answers it.
  http.get("*/api/v2/organizations/:organizationId/bots", () =>
    HttpResponse.json({
      bots: [{ id: "general-assistant", name: "General Assistant" }],
      nextCursor: null,
    }),
  ),
  http.all("*", () => new HttpResponse(null, { status: 404 })),
);
server.events.on("request:start", ({ request }) => {
  const url = new URL(request.url);
  requests.push(`${request.method} ${url.pathname}${url.search}`);
});

let wasServer = true;
beforeAll(() => {
  GlobalRegistrator.register({ url: "http://openbot.invalid/" });
  server.listen({ onUnhandledRequest: "error" });
  /*
   * A browser, with the page in front, as it is for a person reading the conversation. The query
   * library decided it was on a server when it was first evaluated, before this DOM existed, and on
   * a server no read is ever repeated on a timer, which is how a card follows its task.
   */
  wasServer = environmentManager.isServer();
  environmentManager.setIsServer(() => false);
  focusManager.setFocused(true);
});
afterEach(() => {
  cleanup();
  requests.length = 0;
});
afterAll(async () => {
  environmentManager.setIsServer(() => wasServer);
  focusManager.setFocused(undefined);
  server.close();
  await settleReactWork();
  GlobalRegistrator.unregister();
});

function draw(children: ReactNode, client?: QueryClient) {
  const rootRoute = createRootRoute({
    component: () => (
      <>
        {children}
        <Outlet />
      </>
    ),
  });
  const routeTree = rootRoute.addChildren([
    createRoute({
      getParentRoute: () => rootRoute,
      path: "/channel/$channelId",
      component: () => <p>the thread</p>,
    }),
  ]);
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  return render(
    <QueryClientProvider
      client={
        client ??
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

test("a task's card reads where the task stands, and Needs you leads into its thread", async () => {
  task = { ...task, status: "needs_input", next: WAITING };
  const view = draw(
    <TaskCard
      channelId="channel_task"
      taskId="task-1"
      title="Order heirloom tomato seeds"
    />,
  );
  await view.findByText("Needs you");
  // What it waits for is said once, on the needs-you line, not on the card as well.
  expect(view.queryByText(WAITING)).toBeNull();
  const open = view.getByRole("button", { name: /Go to thread/ });
  expect(open.getAttribute("href")).toBe("/channel/channel_task");
  expect(
    view.container
      .querySelector("[data-slot=task-card]")
      ?.getAttribute("data-state"),
  ).toBe("needs");
});

test("a finished task's card reads Done, and its result links to the thread above the words", async () => {
  task = { ...task, status: "ready_for_review", next: null as never };
  const view = draw(
    <>
      <TaskCard channelId="channel_task" taskId="task-1" title="Order seeds" />
      <TaskReport kind="result" taskId="task-1">
        <p>Your order is confirmed: FH-2041.</p>
      </TaskReport>
    </>,
  );
  await view.findByText("Done");
  const link = await view.findByRole("link", {
    name: /Order heirloom tomato seeds/,
  });
  expect(link.getAttribute("href")).toBe("/channel/channel_task");
  // The link comes first, so it never lands between a table and a chart drawn after the words.
  const report = view.container.querySelector("[data-slot=task-report]");
  expect(report?.firstElementChild).toBe(link);
});

test("a needs-you line asks while the task waits, and changes in place once it is answered", async () => {
  task = { ...task, status: "needs_input", next: WAITING };
  const waiting = draw(
    <TaskReport kind="needs" taskId="task-1" words={WAITING}>
      <p>{WAITING}</p>
    </TaskReport>,
  );
  await waiting.findByText("Needs you");
  expect(waiting.getByText(WAITING)).toBeTruthy();
  expect(waiting.getByRole("button", { name: /Go to thread/ })).toBeTruthy();
  cleanup();

  // Answered in the thread: the task carries on, and the line no longer says it is waiting.
  task = { ...task, status: "working", next: null };
  const answered = draw(
    <TaskReport kind="needs" taskId="task-1" words={WAITING}>
      <p>{WAITING}</p>
    </TaskReport>,
  );
  await answered.findByText("Needed you");
  expect(
    answered.getByText("You answered this in its thread. It's carrying on."),
  ).toBeTruthy();
  expect(answered.queryByText(WAITING)).toBeNull();
  expect(answered.getByRole("button", { name: /Open thread/ })).toBeTruthy();
  expect(answered.queryByRole("button", { name: /Go to thread/ })).toBeNull();
  cleanup();

  // Waiting on something else now: this request was answered too.
  task = {
    ...task,
    status: "needs_input",
    next: "Waiting for your answer: Which size?",
  };
  const askedAgain = draw(
    <TaskReport kind="needs" taskId="task-1" words={WAITING}>
      <p>{WAITING}</p>
    </TaskReport>,
  );
  await askedAgain.findByText("Needed you");
  expect(askedAgain.queryByText(WAITING)).toBeNull();
});

test("a Bot's link to a task thread opens in the app, not in a new tab", async () => {
  expect(inAppPath("/channel/channel_task", "http://openbot.invalid")).toBe(
    "/channel/channel_task",
  );
  expect(
    inAppPath(
      "http://openbot.invalid/channel/channel_task?x=1",
      "http://openbot.invalid",
    ),
  ).toBe("/channel/channel_task?x=1");
  expect(
    inAppPath(
      "https://example.com/channel/channel_task",
      "http://openbot.invalid",
    ),
  ).toBeNull();
  expect(inAppPath("//example.com/x", "http://openbot.invalid")).toBeNull();

  const view = draw(
    <Streamdown components={markdownComponents}>
      {"Here it is: [the seed thread](/channel/channel_task)."}
    </Streamdown>,
  );
  const link = await view.findByRole("link", { name: "the seed thread" });
  expect(link.getAttribute("target")).toBeNull();
  expect(link.getAttribute("href")).toBe("/channel/channel_task");
  link.click();
  await view.findByText("the thread");
});

test("a link list reads each task as it is now, not as it was when the Bot looked", async () => {
  // The Bot looked while the task waited on the person; it has finished since.
  task = { ...task, status: "ready_for_review", next: null };
  const view = draw(
    <ThreadLinks
      threads={[
        {
          taskId: "task-1",
          channelId: "channel_task",
          title: "Order heirloom tomato seeds",
          status: "needs_input",
          link: "/channel/channel_task",
        },
      ]}
    />,
  );
  await view.findByText("Done");
  expect(view.queryByText("Needs you")).toBeNull();
  const row = view.getByRole("link", { name: /Order heirloom tomato seeds/ });
  expect(row.getAttribute("href")).toBe("/channel/channel_task");
});

test("a Bot's reaction is read through the generated client and drawn under its message", async () => {
  const view = draw(
    <MessageReactions messageId="message-thanks" threadId="thread_main" />,
  );
  const chip = await view.findByRole("img", {
    name: "General Assistant reacted 👍",
  });
  expect(chip.textContent).toBe("👍");
  // Asked at the API's address, and nowhere else.
  expect(requests).toContain(
    "GET /api/v2/organizations/default/reactions?threadId=thread_main&limit=100",
  );
  expect(requests.filter((request) => request.includes("/api/tasks"))).toEqual(
    [],
  );
});

test("a task's brief links back to the conversation that asked for it, and a check-in's stays plain", async () => {
  task = { ...task, origin: "delegated", originConversationId: "channel_main" };
  const delegated = draw(
    <SentFromBot brief="Order the seeds." threadId="thread_task" />,
  );
  const link = await delegated.findByRole("link", {
    name: "Sent from General Assistant",
  });
  expect(link.getAttribute("href")).toBe("/channel/channel_main");
  link.click();
  await delegated.findByText("the thread");
  cleanup();

  // A check-in's task was not asked for in a conversation, so there is nowhere to go back to.
  task = { ...task, origin: "check_in", originConversationId: null as never };
  const checkIn = draw(
    <SentFromBot brief="Order the seeds." threadId="thread_task" />,
  );
  await checkIn.findByText("Sent from General Assistant");
  expect(checkIn.queryByRole("link")).toBeNull();
});

/** An ISO time this many seconds before now, as the server stamps a task. */
const ago = (seconds: number) =>
  new Date(Date.now() - seconds * 1000).toISOString();

const cardOf = (view: ReturnType<typeof draw>) =>
  view.container.querySelector("[data-slot=task-card]");
const stateOf = (view: ReturnType<typeof draw>) =>
  cardOf(view)?.getAttribute("data-state");
const elapsedOf = (view: ReturnType<typeof draw>) =>
  view.container.querySelector("[data-slot=task-elapsed] time")?.textContent;
const lastActivityOf = (view: ReturnType<typeof draw>) =>
  view.container.querySelector("[data-slot=task-last-activity]")?.textContent;

test("one card follows its task through every state without a reload: working, needs you, stopped, done, couldn't finish", async () => {
  task = {
    ...task,
    status: "working",
    next: null,
    workingSince: ago(125),
    lastActivityAt: ago(4),
  };
  // The card is drawn once and never drawn again: every change below reaches this one card.
  const view = draw(
    <TaskCard channelId="channel_task" taskId="task-1" title="Order seeds" />,
  );
  await view.findByText("Working");
  expect(stateOf(view)).toBe("working");
  // How long it has been at it, counted from when this stretch of work began, and still counting.
  const first = elapsedOf(view);
  expect(first).toMatch(/^2:0[5-9]$/);
  await waitFor(() => expect(elapsedOf(view)).not.toBe(first), {
    timeout: 3_000,
  });
  expect(lastActivityOf(view)).toMatch(/^Last activity .*(second|now)/);

  // It stops for the person: the card says so on its next read, which is seconds away.
  task = { ...task, status: "needs_input", next: WAITING, workingSince: null };
  await view.findByText("Needs you", {}, { timeout: 6_000 });
  expect(stateOf(view)).toBe("needs");
  // Nothing is counted while it waits on the person.
  expect(elapsedOf(view)).toBeUndefined();

  // The person stops it in its thread. Its status is failed, and the card does not call it a failure.
  task = {
    ...task,
    status: "failed",
    next: null,
    failure: "the run was stopped",
    failedAt: ago(1),
    stoppedAt: ago(1),
  };
  await view.findByText("Stopped", {}, { timeout: 6_000 });
  expect(stateOf(view)).toBe("stopped");
  expect(view.queryByText("Couldn't finish")).toBeNull();
  expect(
    view.getByText(
      "You stopped this. Anything it had already done stays done.",
    ),
  ).toBeTruthy();
  expect(lastActivityOf(view)).toMatch(/^Last activity /);
}, 20_000);

test("a card that had stopped reading its task reads it again when the conversation's work changes", async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  task = {
    ...task,
    status: "ready_for_review",
    next: null,
    failure: null,
    failedAt: null,
    stoppedAt: null,
    workingSince: null,
    lastActivityAt: ago(600),
  };
  const view = draw(
    <TaskCard channelId="channel_task" taskId="task-1" title="Order seeds" />,
    client,
  );
  await view.findByText("Done");
  expect(lastActivityOf(view)).toBe("Finished 10 minutes ago");

  // The person replied in its thread and the task carries on. Done is no longer read on a timer,
  // so nothing tells the card: it still says Done well past the few seconds a working card waits.
  task = {
    ...task,
    status: "working",
    workingSince: ago(2),
    lastActivityAt: ago(1),
  };
  const asked = () =>
    requests.filter((request) => request.endsWith("/tasks/task-1")).length;
  const before = asked();
  await new Promise((resolve) => setTimeout(resolve, 3_500));
  expect(asked()).toBe(before);
  expect(stateOf(view)).toBe("done");

  // An event that is not about work leaves the card alone.
  act(() =>
    refreshTaskCards(client, {
      channelId: "channel_main",
      lastMessage: "hello",
      lastMessageAt: ago(0),
      lastMessageAgentId: null,
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 200));
  expect(asked()).toBe(before);

  // The server says the conversation's work changed: the card reads its task again, at once.
  act(() =>
    refreshTaskCards(client, {
      channelId: "channel_main",
      lastMessage: null,
      lastMessageAt: null,
      lastMessageAgentId: null,
      work: [],
      workAt: "2026-11-14T23:59:00.000000Z",
    }),
  );
  await view.findByText("Working", {}, { timeout: 2_000 });
  expect(stateOf(view)).toBe("working");

  // It runs out of tries: Couldn't finish, with why, and not Stopped.
  task = {
    ...task,
    status: "failed",
    failure: "a service didn't answer",
    failedAt: ago(0),
    stoppedAt: null,
    workingSince: null,
  };
  await view.findByText("Couldn't finish", {}, { timeout: 6_000 });
  expect(stateOf(view)).toBe("failed");
  expect(view.getByText("a service didn't answer")).toBeTruthy();
}, 20_000);

test("last activity moves when the task does something, and keeps ageing when it does not", async () => {
  task = {
    ...task,
    status: "working",
    next: null,
    failure: null,
    failedAt: null,
    stoppedAt: null,
    workingSince: ago(400),
    lastActivityAt: ago(57),
  };
  const view = draw(
    <TaskCard channelId="channel_task" taskId="task-1" title="Order seeds" />,
  );
  await view.findByText("Working");
  expect(lastActivityOf(view)).toMatch(/^Last activity 5\d seconds ago$/);
  // The task says and does nothing: the same stamp reads older as the seconds pass, by itself.
  await waitFor(
    () => expect(lastActivityOf(view)).toBe("Last activity 1 minute ago"),
    { timeout: 6_000 },
  );
  // It takes a step: the stamp moves, and the card shows it on its next read.
  task = { ...task, lastActivityAt: ago(0) };
  await waitFor(
    () =>
      expect(lastActivityOf(view)).toMatch(
        /^Last activity (now|\d seconds? ago)$/,
      ),
    { timeout: 6_000 },
  );
}, 20_000);

test("a stopped task's line in the conversation reads Stopped, and its link row too", async () => {
  task = {
    ...task,
    status: "failed",
    failure: "the run was stopped",
    failedAt: ago(30),
    stoppedAt: ago(30),
    workingSince: null,
  };
  const view = draw(
    <>
      <TaskReport kind="failed" taskId="task-1">
        <p>Stopped. I had found two suppliers and ordered nothing.</p>
      </TaskReport>
      <ThreadLinks
        threads={[
          {
            taskId: "task-1",
            channelId: "channel_task",
            title: "Order heirloom tomato seeds",
            status: "failed",
            link: "/channel/channel_task",
          },
        ]}
      />
    </>,
  );
  const line = await view.findByRole("region", { name: "A task was stopped" });
  expect(line.textContent).toContain("Stopped · Order heirloom tomato seeds");
  expect(view.queryByText(/Couldn't finish/)).toBeNull();
  expect(
    view.container.querySelector("li[data-state]")?.getAttribute("data-state"),
  ).toBe("stopped");
});
