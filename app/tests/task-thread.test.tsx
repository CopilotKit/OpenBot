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
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";
import { delay, HttpResponse, http } from "msw";
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
import { queryClient } from "@/query-client";
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
  agent: null as { id: string; name: string } | null,
  status: "needs_input",
  failure: null as string | null,
  failedAt: null as string | null,
  stoppedAt: null as string | null,
  workingSince: null as string | null,
  tryingAgainAt: null as string | null,
  lastActivityAt: "2026-11-12T22:00:00.000Z",
  next: WAITING as string | null,
  resolvedAt: null,
  createdAt: "2026-11-12T22:00:00.000Z",
  updatedAt: "2026-11-12T22:00:00.000Z",
};
const requests: string[] = [];
/** How long the server takes to answer a read of the task. */
let taskReadMs = 0;
/** The stops asked for, with the key each was asked with, so a retry is the same stop. */
const stops: { taskId: string; key: string | null }[] = [];
const server = setupServer(
  // Stop: the server answers with the task as it stands once the stop has landed.
  http.post(
    "*/api/v2/organizations/:organizationId/tasks/:id/stop",
    ({ params, request }) => {
      stops.push({
        taskId: String(params.id),
        key: request.headers.get("Idempotency-Key"),
      });
      task = {
        ...task,
        status: "failed",
        next: null,
        workingSince: null,
        failure: "you stopped it",
        failedAt: ago(0),
        stoppedAt: ago(0),
      };
      return HttpResponse.json({ task });
    },
  ),
  // Tasks and reactions, at the API's addresses and in its shapes, as the server answers them.
  http.get(
    "*/api/v2/organizations/:organizationId/tasks/:id",
    async ({ params }) => {
      // As long as a loaded server takes to read a task.
      if (taskReadMs > 0) await delay(taskReadMs);
      return params.id === task.id
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
          );
    },
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

  // Answered: the task carries on, and the line no longer says it is waiting.
  task = { ...task, status: "working", next: null };
  const answered = draw(
    <TaskReport kind="needs" taskId="task-1" words={WAITING}>
      <p>{WAITING}</p>
    </TaskReport>,
  );
  await answered.findByText("Needed you");
  expect(
    answered.getByText("You answered this. It's carrying on."),
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

/*
 * Found on the re-test: a person pressed Allow on the Bots page's Needs you board, and the line in
 * the conversation that asked read "You answered this in its thread, and it's done." The card can't
 * know where the answer was given (the thread, the board, the inbox), so it never says.
 */
test("an answered needs-you line never claims the answer was given in the thread", async () => {
  task = { ...task, status: "ready_for_review", next: null as never };
  const view = draw(
    <TaskReport kind="needs" taskId="task-1" words={WAITING}>
      <p>{WAITING}</p>
    </TaskReport>,
  );
  await view.findByText("Needed you");
  expect(view.getByText("You answered this, and it's done.")).toBeTruthy();
  expect(view.queryByText(/in its thread/)).toBeNull();
});

/*
 * Found live: Stop pressed on a task that was waiting on the person's answer, and the needs-you line
 * in the conversation that asked then read "You answered this, and stopped it after." They had
 * answered nothing. The line can't know whether they answered first, so it says only the stop.
 */
test("a needs-you line for a task the person stopped never says they answered it", async () => {
  task = {
    ...task,
    status: "failed",
    stoppedAt: "2026-11-16T14:00:00.000Z",
    failure: "you stopped it",
    next: null as never,
  };
  const view = draw(
    <TaskReport kind="needs" taskId="task-1" words={WAITING}>
      <p>{WAITING}</p>
    </TaskReport>,
  );
  await view.findByText("Needed you");
  expect(
    view.getByText("You stopped this task, so it no longer needs this."),
  ).toBeTruthy();
  expect(view.queryByText(/You answered/)).toBeNull();
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

  // It runs out of tries: Couldn't finish, and not Stopped. Why is said on the line it reports.
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
}, 20_000);

/*
 * Found under load, five conversations working at once: work events came every 100 to 300 ms, a
 * read of a task took longer, and every event cancelled every card's read and started it again. A
 * card left open read Done for 12 s after its task needed the person, so it showed no Stop, and a
 * Stop click waiting for one timed out.
 */
test("a card left open reads its task's change while work events come faster than a read answers", async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  task = {
    ...task,
    // Asked for in the conversation "channel_main".
    originConversationId: "channel_main",
    status: "ready_for_review",
    next: null,
    failure: null,
    failedAt: null,
    stoppedAt: null,
    workingSince: null,
    lastActivityAt: ago(60),
  };
  const view = draw(
    <TaskCard channelId="channel_task" taskId="task-1" title="Order seeds" />,
    client,
  );
  await view.findByText("Done");
  // Steered in its thread, it raised an approval: it needs the person now.
  task = { ...task, status: "needs_input", next: WAITING, workingSince: null };
  taskReadMs = 300;
  let tick = 0;
  // Its own conversation's work changes, among five others', every 50 ms.
  const storm = setInterval(() => {
    tick += 1;
    act(() =>
      refreshTaskCards(client, {
        channelId:
          tick % 6 === 0 ? "channel_main" : `channel_other_${tick % 6}`,
        lastMessage: null,
        lastMessageAt: null,
        lastMessageAgentId: null,
        work: [],
        workAt: `2026-11-16T17:00:${String(tick % 60).padStart(2, "0")}.000000Z`,
      }),
    );
  }, 50);
  try {
    await view.findByText("Needs you", {}, { timeout: 2_000 });
    expect(stateOf(view)).toBe("needs");
    expect(view.getByRole("button", { name: "Stop" })).toBeTruthy();
  } finally {
    clearInterval(storm);
    taskReadMs = 0;
  }
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

const tryingAgainOf = (view: ReturnType<typeof draw>) =>
  view.container.querySelector("[data-slot=task-trying-again]");
const waitingOf = (view: ReturnType<typeof draw>) =>
  cardOf(view)?.getAttribute("data-waiting");

test("a working task that waits to try again says so and when, and reads as before once the time has passed", async () => {
  // Its turn hit a rate limit twelve minutes in, and is tried again in ten minutes.
  const at = new Date(Date.now() + 600_000);
  task = {
    ...task,
    status: "working",
    next: null,
    failure: null,
    failedAt: null,
    stoppedAt: null,
    workingSince: ago(720),
    lastActivityAt: ago(700),
    tryingAgainAt: at.toISOString(),
  };
  const view = draw(
    <TaskCard channelId="channel_task" taskId="task-1" title="Order seeds" />,
  );
  // It is still working, and still counting: only the line under it changes.
  await view.findByText("Working");
  expect(stateOf(view)).toBe("working");
  expect(elapsedOf(view)).toMatch(/^12:0\d$/);
  expect(waitingOf(view)).toBe("retry");
  // The time is the person's own clock's, with the date only when it is another day.
  const time = at.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
  const sameDay = at.toDateString() === new Date().toDateString();
  expect(tryingAgainOf(view)?.textContent).toBe(
    sameDay
      ? `Waiting to try again at ${time}`
      : `Waiting to try again on ${at.toLocaleDateString(undefined, { month: "short", day: "numeric" })} at ${time}`,
  );
  expect(tryingAgainOf(view)?.querySelector("time")?.dateTime).toBe(
    at.toISOString(),
  );
  expect(lastActivityOf(view)).toBeUndefined();

  // A wait that ends on another day names the day.
  const later = new Date(Date.now() + 3 * 86_400_000);
  task = { ...task, tryingAgainAt: later.toISOString() };
  await waitFor(
    () =>
      expect(tryingAgainOf(view)?.textContent).toBe(
        `Waiting to try again on ${later.toLocaleDateString(undefined, { month: "short", day: "numeric" })} at ${later.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`,
      ),
    { timeout: 6_000 },
  );

  // Nearly there: no clock time for a wait of seconds.
  task = { ...task, tryingAgainAt: new Date(Date.now() + 5_000).toISOString() };
  await waitFor(
    () =>
      expect(tryingAgainOf(view)?.textContent).toBe("Trying again in a moment"),
    { timeout: 6_000 },
  );
  expect(waitingOf(view)).toBe("retry");

  // The time passes with nothing new read from the task: the card goes back to what it says today.
  await waitFor(() => expect(tryingAgainOf(view)).toBeNull(), {
    timeout: 9_000,
  });
  expect(waitingOf(view)).toBeNull();
  expect(lastActivityOf(view)).toMatch(/^Last activity 1\d minutes ago$/);
  expect(view.getByText("Working")).toBeTruthy();
}, 30_000);

test("a task that is not waiting to try again, or is no longer working, reads as it does today", async () => {
  // The server says nothing of a wait.
  task = {
    ...task,
    status: "working",
    next: null,
    failure: null,
    failedAt: null,
    stoppedAt: null,
    workingSince: ago(125),
    lastActivityAt: ago(120),
    tryingAgainAt: null,
  };
  const none = draw(
    <TaskCard channelId="channel_task" taskId="task-1" title="Order seeds" />,
  );
  await none.findByText("Working");
  expect(lastActivityOf(none)).toBe("Last activity 2 minutes ago");
  expect(tryingAgainOf(none)).toBeNull();
  expect(waitingOf(none)).toBeNull();
  cleanup();

  // A server from before the field: the task it returns does not carry it at all.
  const { tryingAgainAt: _absent, ...without } = task;
  task = without as typeof task;
  expect("tryingAgainAt" in task).toBe(false);
  const absent = draw(
    <TaskCard channelId="channel_task" taskId="task-1" title="Order seeds" />,
  );
  await absent.findByText("Working");
  expect(lastActivityOf(absent)).toBe("Last activity 2 minutes ago");
  expect(tryingAgainOf(absent)).toBeNull();
  expect(waitingOf(absent)).toBeNull();
  cleanup();
  task = { ...task, tryingAgainAt: null };

  // A time already behind this clock when the card is first drawn, as after a reload.
  task = { ...task, tryingAgainAt: ago(30) };
  const past = draw(
    <TaskCard channelId="channel_task" taskId="task-1" title="Order seeds" />,
  );
  await past.findByText("Working");
  expect(lastActivityOf(past)).toBe("Last activity 2 minutes ago");
  expect(tryingAgainOf(past)).toBeNull();
  expect(waitingOf(past)).toBeNull();
  cleanup();

  // It ran out of tries: a time still ahead is not a wait any more.
  task = {
    ...task,
    status: "failed",
    failure: "a service didn't answer",
    failedAt: ago(1),
    workingSince: null,
    tryingAgainAt: new Date(Date.now() + 600_000).toISOString(),
  };
  const failed = draw(
    <TaskCard channelId="channel_task" taskId="task-1" title="Order seeds" />,
  );
  await failed.findByText("Couldn't finish");
  expect(lastActivityOf(failed)).toMatch(/^Last activity /);
  expect(tryingAgainOf(failed)).toBeNull();
  expect(waitingOf(failed)).toBeNull();
});

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

test("a task that couldn't finish says why once, on the line it reports, not on its card as well", async () => {
  // What the server says on each, and the line it reports under the card with the next step.
  for (const [failure, reported, reason] of [
    [
      "this Bot isn't shared with you any more",
      "This Bot isn't shared with you any more, so it stopped this task. Its owner or an admin can share it again.",
      /isn't shared with you any more/,
    ],
    [
      "Pipeline Bot isn't shared with you",
      "I couldn't ask Pipeline Bot because it isn't shared with you. Its owner or an admin can share it with you.",
      /isn't shared with you/,
    ],
  ] as const) {
    task = {
      ...task,
      status: "failed",
      next: null,
      failure,
      failedAt: ago(5),
      stoppedAt: null,
      workingSince: null,
    };
    // As the conversation that asked draws them: the card, and the line under it.
    const view = draw(
      <>
        <TaskCard
          channelId="channel_task"
          taskId="task-1"
          title="Order seeds"
        />
        <TaskReport kind="failed" taskId="task-1">
          <p>{reported}</p>
        </TaskReport>
      </>,
    );
    const card = await view.findByRole("region", { name: /^Task: / });
    await waitFor(() => expect(card.textContent).toContain("Couldn't finish"));
    // The card says that it couldn't finish; why, and what to do, is said once, on the line.
    expect(card.textContent).not.toMatch(reason);
    const line = view.getByRole("region", { name: "A task couldn't finish" });
    expect(line.textContent).toContain(reported);
    expect(
      view.getAllByText(reason, { exact: false, selector: "p" }),
    ).toHaveLength(1);
    cleanup();
  }
});

/*
 * An admin dismissing the Request access a task waited on ends it as couldn't finish, after its
 * result was already said: no failed line is reported under it. The card says only that it couldn't
 * finish, so the result above the app's card says why, once, and does not read as done.
 */
test("a result whose task then couldn't finish says why, once, and doesn't read as done", async () => {
  task = {
    ...task,
    status: "failed",
    next: null,
    failure: "an admin didn't give this Bot Slack",
    failedAt: ago(1),
    stoppedAt: null,
    workingSince: null,
  };
  const view = draw(
    <>
      <TaskCard channelId="channel_task" taskId="task-1" title="Order seeds" />
      <TaskReport kind="result" taskId="task-1">
        <p>
          “refunds batch done” was not posted because I haven't been granted
          Slack access.
        </p>
      </TaskReport>
    </>,
  );
  const link = await view.findByRole("link", {
    name: /Order heirloom tomato seeds/,
  });
  await waitFor(() => expect(link.getAttribute("data-state")).toBe("failed"));
  expect(
    view.container.textContent?.match(/an admin didn't give this Bot Slack/gi),
  ).toHaveLength(1);
});

test("a result whose task now needs the person doesn't read as done above its card", async () => {
  task = {
    ...task,
    status: "needs_input",
    next: "This needs you: Slack isn't ready for this Bot yet",
    failure: null,
    stoppedAt: null,
  };
  const view = draw(
    <TaskReport kind="result" taskId="task-1">
      <p>
        “refunds batch done” was not posted because I haven't been granted Slack
        access.
      </p>
    </TaskReport>,
  );
  const link = await view.findByRole("link", {
    name: /Order heirloom tomato seeds/,
  });
  await waitFor(() => expect(link.getAttribute("data-state")).toBe("needs"));
  task = { ...task, status: "ready_for_review", next: null };
  cleanup();
  const done = draw(
    <TaskReport kind="result" taskId="task-1">
      <p>Posted.</p>
    </TaskReport>,
  );
  const doneLink = await done.findByRole("link", {
    name: /Order heirloom tomato seeds/,
  });
  await waitFor(() => expect(doneLink.getAttribute("data-state")).toBe("done"));
});

test("a result whose task the person then stopped reads stopped, not done, away from its card", async () => {
  task = {
    ...task,
    status: "failed",
    next: null,
    failure: "you stopped it",
    failedAt: ago(1),
    stoppedAt: ago(1),
    workingSince: null,
  };
  const view = draw(
    <TaskReport kind="result" taskId="task-1">
      <p>The guide covers refunds in France and Germany so far.</p>
    </TaskReport>,
  );
  const link = await view.findByRole("link", {
    name: /Order heirloom tomato seeds/,
  });
  await waitFor(() => expect(link.getAttribute("data-state")).toBe("stopped"));
});

test("a result directly under its task's card leads with no second link to the task", async () => {
  task = { ...task, status: "ready_for_review", next: null, failure: null };
  const view = draw(
    <>
      <TaskReport kind="result" taskId="task-1" underCard>
        <p>Your order is confirmed: FH-2041.</p>
      </TaskReport>
      <TaskReport kind="result" taskId="task-1">
        <p>It ships on Thursday.</p>
      </TaskReport>
    </>,
  );
  // The task is read: the result away from its card leads with its link.
  const link = await view.findByRole("link", {
    name: /Order heirloom tomato seeds/,
  });
  expect(view.getAllByRole("link")).toEqual([link]);
  expect(
    view.getByText("It ships on Thursday.").closest("[data-slot=task-report]"),
  ).toBe(link.closest("[data-slot=task-report]"));
});

test("Stop on a working task's card stops it through the API, and the card reads Stopped at once with no Stop left on it", async () => {
  task = {
    ...task,
    status: "working",
    next: null,
    failure: null,
    failedAt: null,
    stoppedAt: null,
    workingSince: ago(30),
    lastActivityAt: ago(2),
  };
  stops.length = 0;
  queryClient.clear();
  const view = draw(
    <TaskCard channelId="channel_task" taskId="task-1" title="Order seeds" />,
    queryClient,
  );
  await view.findByText("Working");
  const stop = view.getByRole("button", { name: "Stop" });
  // Beside the way into the thread, which stays.
  expect(view.getByRole("button", { name: /Open thread/ })).toBeTruthy();

  fireEvent.click(stop);

  // Read from the answer, before any poll: the card says Stopped, and that nothing done is undone.
  await view.findByText("Stopped", {}, { timeout: 2_000 });
  expect(stateOf(view)).toBe("stopped");
  expect(
    view.getByText(
      "You stopped this. Anything it had already done stays done.",
    ),
  ).toBeTruthy();
  expect(view.queryByRole("button", { name: "Stop" })).toBeNull();
  expect(stops).toHaveLength(1);
  expect(stops[0]?.taskId).toBe("task-1");
  expect(stops[0]?.key).toBeTruthy();
  queryClient.clear();
});

test("a task that needs the person can be stopped from its card too, and a finished one offers no Stop", async () => {
  task = {
    ...task,
    status: "needs_input",
    next: WAITING,
    failure: null,
    failedAt: null,
    stoppedAt: null,
    workingSince: null,
  };
  const waiting = draw(
    <TaskCard channelId="channel_task" taskId="task-1" title="Order seeds" />,
  );
  await waiting.findByText("Needs you");
  expect(waiting.getByRole("button", { name: "Stop" })).toBeTruthy();
  cleanup();

  task = { ...task, status: "ready_for_review", next: "Ordered." };
  const done = draw(
    <TaskCard channelId="channel_task" taskId="task-1" title="Order seeds" />,
  );
  await done.findByText("Done");
  expect(done.queryByRole("button", { name: "Stop" })).toBeNull();
});

test("a task handed to an agent names it on its card and in its thread, and a task the Bot does itself names none", async () => {
  // Handed to an agent: who is on it while it works, then who did it.
  task = {
    ...task,
    status: "working",
    next: null,
    agent: { id: "bag_analyst", name: "Pipeline analyst" },
  };
  const working = draw(
    <TaskCard channelId="channel_task" taskId="task-1" title="Forecast" />,
  );
  expect(
    (await working.findByText("Pipeline analyst is on it")).getAttribute(
      "data-slot",
    ),
  ).toBe("task-agent");
  cleanup();

  task = { ...task, status: "ready_for_review" };
  const done = draw(
    <TaskCard channelId="channel_task" taskId="task-1" title="Forecast" />,
  );
  await done.findByText("Done by Pipeline analyst");
  cleanup();

  // The thread's brief says who sent it and to which agent.
  const brief = draw(
    <SentFromBot brief="Forecast Q4." threadId="thread_task" />,
  );
  await brief.findByText("to Pipeline analyst");
  cleanup();

  // The Bot did it itself: the card names no agent, and the brief says only who sent it.
  task = { ...task, status: "working", agent: null };
  const itself = draw(
    <TaskCard channelId="channel_task" taskId="task-1" title="Forecast" />,
  );
  await itself.findByText("Working");
  expect(itself.container.querySelector("[data-slot=task-agent]")).toBeNull();
  cleanup();
  const plain = draw(
    <SentFromBot brief="Forecast Q4." threadId="thread_task" />,
  );
  await plain.findByText(/Sent from/);
  expect(plain.container.querySelector("[data-slot=task-agent]")).toBeNull();
});
