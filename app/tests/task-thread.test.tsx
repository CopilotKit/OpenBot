import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import type { ReactNode } from "react";
import { Streamdown } from "streamdown";
import {
  MessageReactions,
  TaskCard,
  TaskReport,
} from "@/components/tasks/task-thread";
import { todayRoutes } from "@/lib/api/served-today";
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
  agentId: "general-assistant",
  channelId: "channel_task",
  threadId: "thread_task",
  title: "Order heirloom tomato seeds",
  why: null,
  origin: "delegated",
  suggestionId: null,
  sourceApp: null,
  sourceLink: null,
  originChannelId: "channel_main",
  status: "needs_input",
  failure: null,
  failedAt: null,
  next: WAITING as string | null,
  resolvedAt: null,
  createdAt: "2026-11-12T22:00:00.000Z",
  updatedAt: "2026-11-12T22:00:00.000Z",
};
const requests: string[] = [];
const server = setupServer(
  http.get("*/api/tasks/:id", ({ params }) =>
    params.id === task.id
      ? HttpResponse.json({ task })
      : HttpResponse.json(
          { error: "Couldn't find that task." },
          { status: 404 },
        ),
  ),
  http.get("*/api/tasks/reactions/:threadId", ({ params }) =>
    HttpResponse.json({
      reactions:
        params.threadId === "thread_main"
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
  http.get("*/api/agents", () =>
    HttpResponse.json({
      agents: [{ id: "general-assistant", name: "General Assistant" }],
    }),
  ),
  http.all("*", () => new HttpResponse(null, { status: 404 })),
);
server.events.on("request:start", ({ request }) => {
  const url = new URL(request.url);
  requests.push(`${request.method} ${url.pathname}${url.search}`);
});

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://openbot.invalid/" });
  server.listen({ onUnhandledRequest: "error" });
});
afterEach(() => {
  cleanup();
  requests.length = 0;
});
afterAll(async () => {
  server.close();
  todayRoutes.on = true;
  await settleReactWork();
  GlobalRegistrator.unregister();
});

function draw(children: ReactNode) {
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

test("a Bot's reaction is read through the generated client and drawn under its message", async () => {
  const view = draw(
    <MessageReactions messageId="message-thanks" threadId="thread_main" />,
  );
  const chip = await view.findByRole("img", {
    name: "General Assistant reacted 👍",
  });
  expect(chip.textContent).toBe("👍");
  // Asked at the API's address, and sent where today's server answers it.
  expect(requests).toContain("GET /api/tasks/reactions/thread_main");
});

test("today's table sends the reactions operation where today's server answers it", async () => {
  const { servedToday } = await import("@/lib/api/served-today");
  const route = servedToday(
    "/api/v2/organizations/default/reactions?threadId=thread%2Fwith%20slash&limit=100",
  );
  expect(route?.path).toBe("/api/tasks/reactions/thread%2Fwith%20slash");
  expect(route?.answer({ reactions: [{ emoji: "👍" }] })).toEqual({
    reactions: [{ emoji: "👍" }],
    nextCursor: null,
  });
  expect(
    servedToday("/api/v2/organizations/default/reactions", "POST"),
  ).toBeUndefined();
});
