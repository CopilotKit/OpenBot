import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import type { ReactNode } from "react";
import {
  MessageReactions,
  TaskCard,
  TaskReport,
} from "@/components/tasks/task-thread";
import { todayRoutes } from "@/lib/api/served-today";
import { settleReactWork } from "./settle-react-work";

/**
 * What a Bot's task threads draw in the conversation that asked for them: the task's card, which
 * reads the task and turns Needs you or Done in place; the line a task says when it needs the person,
 * with the way into its thread; the result's link; and the Bot's reaction under a message, read
 * through the client generated from api/openapi.yaml.
 *
 * The server is faked at the HTTP boundary only, answering where today's server answers.
 */

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
  next: "Waiting for your approval: click the button “Place order” on shop.example",
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
  const rootRoute = createRootRoute({ component: () => <>{children}</> });
  const routeTree = rootRoute.addChildren([
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
  task = { ...task, status: "needs_input" };
  const view = draw(
    <TaskCard
      channelId="channel_task"
      taskId="task-1"
      title="Order heirloom tomato seeds"
    />,
  );
  await view.findByText("Needs you");
  expect(view.getByText(task.next)).toBeTruthy();
  const open = view.getByRole("button", { name: /Open thread/ });
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

test("a task that needed the person and was answered says so without asking again", async () => {
  task = { ...task, status: "working" };
  const view = draw(
    <TaskReport kind="needs" taskId="task-1">
      <p>{task.next}</p>
    </TaskReport>,
  );
  await view.findByText("Needed you");
  expect(view.getByRole("button", { name: /Open thread/ })).toBeTruthy();
  expect(view.queryByRole("button", { name: /Go to thread/ })).toBeNull();
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
