import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, within } from "@testing-library/react";
import { BotActivitySections } from "@/components/bot-profile/activity";
import type { ActivityItem, BotActivity } from "@/lib/bot-lifecycle/queries";
import { activityResponse, answerBotsList, botOperationPath } from "./bots-api";
import {
  CONVERSATIONS_PATH,
  conversationPage,
  TASKS_PATH,
  taskOf,
} from "./conversations-api";
import { answerScheduleLists, pathOf } from "./schedules-api";
import { settleReactWork } from "./settle-react-work";

/**
 * A Bot's Activity page lists every thread the Bot owns, grouped by where it stands: what needs the
 * person first, then what is working, done and failed, then what recurs. The conversations a Bot
 * opened to do a piece of work in are listed here, each with a link back to the conversation that
 * asked for it, and routines and check-ins are here too.
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
});

const BOT = "scout";
const NOW = new Date().toISOString();

const task = (id: string, status: string, rest: Record<string, unknown> = {}) =>
  taskOf({
    id,
    agentId: BOT,
    channelId: `channel_${id}`,
    threadId: `thread_${id}`,
    title: `Task ${id}`,
    why: null,
    origin: "delegated",
    suggestionId: null,
    sourceApp: null,
    sourceLink: null,
    originChannelId: "channel_main",
    status,
    failure: status === "failed" ? "a service didn't answer" : null,
    failedAt: status === "failed" ? NOW : null,
    next: null,
    resolvedAt: status === "resolved" ? NOW : null,
    createdAt: NOW,
    updatedAt: NOW,
    ...rest,
  });

/** The conversation the delegated tasks were asked for in. */
const MAIN = {
  id: "channel_main",
  name: "Scout",
  agentIds: [BOT],
  summary: "Plan the offsite",
  opening: "Help me plan the offsite",
  lastMessage: null,
  lastMessageAgentId: null,
  createdAt: NOW,
  pinned: false,
  lastReadAt: null,
};

const item = (rest: Partial<ActivityItem>): ActivityItem => ({
  id: "item",
  kind: "routine",
  title: "Item",
  detail: null,
  status: "running",
  at: NOW,
  channelId: null,
  needsYou: false,
  stoppable: false,
  cancellable: false,
  ...rest,
});

function draw(
  activity: Partial<BotActivity>,
  tasks: readonly unknown[],
  checkIns: readonly unknown[] = [],
) {
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = pathOf(input);
    if (path === botOperationPath(BOT, "activity"))
      return activityResponse(activity);
    if (path === TASKS_PATH) return Response.json({ tasks, nextCursor: null });
    if (path === CONVERSATIONS_PATH)
      return Response.json(conversationPage([MAIN]));
    return (
      answerScheduleLists(input, init, { checkIns }) ??
      answerBotsList(input, init, { visible: [{ id: BOT, name: "Scout" }] }) ??
      Response.json({ error: "unexpected" }, { status: 404 })
    );
  }) as typeof fetch;
  const router = createRouter({
    routeTree: createRootRoute({
      component: () => <BotActivitySections agentId={BOT} />,
    }),
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

/** The section headings in the order they are drawn, and the titles of the rows under each. */
function sections(container: HTMLElement) {
  return [...container.querySelectorAll("section")].map((section) => ({
    heading: section.querySelector("h2")?.textContent ?? "",
    rows: [...section.querySelectorAll("[data-slot=item-title]")].map(
      (title) => title.textContent ?? "",
    ),
  }));
}

test("lists the Bot's threads by state: needs you, working, scheduled, done, failed, recurring", async () => {
  const view = draw(
    {
      inProgress: [
        item({
          id: "approval:1",
          kind: "approval",
          title: "Send the invoice",
          status: "waiting for you",
          needsYou: true,
        }),
        // Raised inside the task that needs input: that task, not a second row.
        item({
          id: "question:2",
          kind: "question",
          title: "Which venue?",
          status: "waiting for you",
          needsYou: true,
          channelId: "channel_needs",
        }),
        item({ id: "routine-run:1", title: "Morning digest run" }),
      ],
      scheduled: [
        item({
          id: "routine:r1",
          title: "Morning digest",
          status: "scheduled",
        }),
        item({
          id: "wake-up:42",
          kind: "follow_up",
          title: "Chase the invoice reply",
          status: "scheduled",
          cancellable: true,
        }),
      ],
      onDemand: [
        item({
          id: "responsibility:watch",
          kind: "responsibility",
          title: "Watch OpenBot releases",
          status: "active",
        }),
      ],
      completed: [
        item({
          id: "routine-run:2",
          title: "Evening digest run",
          status: "succeeded",
        }),
        item({
          id: "routine-run:3",
          title: "Weekly report run",
          status: "failed",
        }),
      ],
    },
    [
      task("done", "resolved"),
      task("failed", "failed"),
      task("working", "working"),
      task("needs", "needs_input"),
      task("review", "ready_for_review"),
      // A check-in's task, started from an item: no conversation asked for it.
      task("checkin", "working", { origin: "check_in", originChannelId: null }),
      // Another Bot's task is not this Bot's activity.
      { ...task("other", "working"), botId: "writer" },
    ],
    [
      {
        id: "p1",
        botId: BOT,
        conversationId: "c1",
        focus: "",
        subject: "Unpaid invoices",
        sourceLink: null,
        enabled: true,
        intervalMinutes: 60,
        nextRunAt: NOW,
        lastRunAt: null,
        lastStatus: "idle",
        lastError: null,
        lastRun: null,
        createdAt: NOW,
      },
    ],
  );
  await view.findByRole("heading", { name: "Needs you" });
  await view.findByText("Unpaid invoices");
  const drawn = sections(view.container);
  expect(drawn.map((section) => section.heading)).toEqual([
    "Needs you",
    "Working",
    "Scheduled",
    "Done",
    "Failed",
    "Recurring",
  ]);
  const rows = Object.fromEntries(
    drawn.map((section) => [section.heading, section.rows.sort()]),
  );
  expect(rows["Needs you"]).toEqual(["Send the invoice", "Task needs"]);
  expect(rows.Working).toEqual([
    "Morning digest run",
    "Task checkin",
    "Task working",
  ]);
  expect(rows.Scheduled).toEqual(["Chase the invoice reply"]);
  expect(rows.Done).toEqual(["Evening digest run", "Task done", "Task review"]);
  expect(rows.Failed).toEqual(["Task failed", "Weekly report run"]);
  expect(rows.Recurring).toEqual([
    "Morning digest",
    "Routines",
    "Unpaid invoicesCheck-in",
    "Watch OpenBot releases",
  ]);
  expect(view.queryByText("Task other")).toBeNull();
  expect(view.queryByText("Which venue?")).toBeNull();

  // Each task opens its own thread, and links back to the conversation that asked for it.
  const row = view.getByText("Task working").closest("[data-slot=item]");
  const links = [...(row?.querySelectorAll("a") ?? [])].map((link) => [
    link.textContent,
    link.getAttribute("href"),
  ]);
  expect(links).toContainEqual(["Open", "/channel/channel_working"]);
  expect(links).toContainEqual([
    "Asked in Plan the offsite",
    "/channel/channel_main",
  ]);
  // A check-in's task has no conversation to go back to.
  const checkIn = view.getByText("Task checkin").closest("[data-slot=item]");
  expect(checkIn?.querySelector("[data-slot=task-asked-in]")).toBeNull();
});

test("a group with nothing in it is not drawn, and a Bot with nothing says so once", async () => {
  const some = draw({}, [task("working", "working")]);
  await some.findByRole("heading", { name: "Working" });
  for (const name of ["Needs you", "Scheduled", "Done", "Failed", "Recurring"])
    expect(some.queryByRole("heading", { name })).toBeNull();
  expect(some.queryByText("No activity yet")).toBeNull();
  cleanup();

  const none = draw({}, []);
  await none.findByText("No activity yet");
  for (const name of ["Needs you", "Working", "Done", "Failed", "Recurring"])
    expect(none.queryByRole("heading", { name })).toBeNull();
});

test("a task the person stopped reads Stopped on its row, in its card's words, and can be tried again", async () => {
  const view = draw({}, [
    task("stopped", "failed", { failure: "you stopped it", stoppedAt: NOW }),
    task("failed", "failed"),
  ]);
  const stopped = within(
    (await view.findByText("Task stopped")).closest(
      "[data-slot=item]",
    ) as HTMLElement,
  );
  expect(stopped.getByText(/^Stopped · /)).toBeTruthy();
  expect(
    stopped.getByText(
      "You stopped this. Anything it had already done stays done.",
    ),
  ).toBeTruthy();
  expect(stopped.queryByText(/^Failed · /)).toBeNull();
  expect(stopped.queryByText(/Couldn't finish/)).toBeNull();
  expect(stopped.getByRole("button", { name: "Try again" })).toBeTruthy();

  // One that couldn't finish on its own still says so.
  const failed = within(
    view.getByText("Task failed").closest("[data-slot=item]") as HTMLElement,
  );
  expect(failed.getByText(/^Failed · /)).toBeTruthy();
  expect(
    failed.getByText("Couldn't finish: a service didn't answer."),
  ).toBeTruthy();
  expect(failed.queryByText(/^Stopped · /)).toBeNull();
  expect(failed.getByRole("button", { name: "Try again" })).toBeTruthy();
});
