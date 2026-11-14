import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { environmentManager, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { GoalPage } from "@/components/responsibilities/goal-page";
import {
  type ResponsibilityRecord,
  triggersQueryOptions,
} from "@/lib/responsibilities";
import type { RoutineRecord } from "@/lib/routines/queries";
import { queryClient } from "@/query-client";
import { settleReactWork } from "./settle-react-work";

let wasServer = true;
beforeAll(() => {
  GlobalRegistrator.register();
  wasServer = environmentManager.isServer();
  environmentManager.setIsServer(() => false);
});
afterAll(async () => {
  await settleReactWork();
  environmentManager.setIsServer(() => wasServer);
  GlobalRegistrator.unregister();
});

const originalFetch = global.fetch;
const sent: { method: string; url: string; body: unknown }[] = [];

beforeEach(() => {
  queryClient.clear();
  sent.length = 0;
  global.fetch = Object.assign(
    async (path: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = String(path);
      const method = init?.method ?? "GET";
      if (method !== "GET") {
        sent.push({
          method,
          url,
          body: init?.body ? JSON.parse(String(init.body)) : undefined,
        });
        return Response.json({});
      }
      if (url === "/api/routines/routine-1/runs")
        return Response.json({ runs: [scheduledRun] });
      return Response.json({ triggers: [], runs: [] });
    },
    { preconnect: originalFetch.preconnect },
  );
});
afterEach(() => {
  cleanup();
  global.fetch = originalFetch;
});

const goal: ResponsibilityRecord = {
  id: "goal-1",
  agentId: "bot-1",
  channelId: "c1",
  threadId: "t1",
  title: "Watch the queue",
  instruction: "Tell me when the queue backs up.",
  successCriteria: "The queue is empty.",
  status: "active",
  progress: "",
  lastResult: null,
  subscriptions: [],
  recurring: false,
  endsWhenMet: false,
  updatedAt: "2026-11-10T10:00:00Z",
};

/** One firing of the goal's schedule, as `GET /api/routines/:id/runs` lists it. */
const scheduledRun = {
  id: "run-1",
  status: "failed",
  startedAt: "2026-11-10T09:00:00Z",
  finishedAt: "2026-11-10T09:01:00Z",
  error: "The queue couldn't be read.",
  source: "schedule",
};

const routine = (overrides: Partial<RoutineRecord> = {}): RoutineRecord => ({
  id: "routine-1",
  agentId: "bot-1",
  schedule: "Weekdays at 09:00",
  timezone: "UTC",
  instruction: "Check the queue.",
  title: null,
  channel: { id: "c1", name: null, title: "Queue", gone: false },
  enabled: true,
  nextRunAt: "2999-01-01T09:00:00.000Z",
  lastRun: null,
  goalId: "goal-1",
  ...overrides,
});

function open(
  /** Undefined: the Routines list couldn't read its routines. */
  routines: RoutineRecord[] | undefined,
  status: ResponsibilityRecord["status"] = "active",
  overrides: Partial<ResponsibilityRecord> = {},
) {
  const root = createRootRoute();
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: root.addChildren([
      createRoute({
        getParentRoute: () => root,
        path: "/",
        component: () => (
          <GoalPage
            back={{ to: "/" }}
            goal={{ ...goal, ...overrides, status }}
            routines={routines}
          />
        ),
      }),
    ]),
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

/** Resolves once the goal's triggers request has been answered, so nothing below reads a half-loaded page. */
async function triggersLoaded() {
  await waitFor(() =>
    expect(
      queryClient.getQueryState(triggersQueryOptions(goal.id).queryKey)?.status,
    ).toBe("success"),
  );
}

/** The line under the title, read only once the goal's triggers have loaded. */
async function header(view: ReturnType<typeof open>) {
  await triggersLoaded();
  const description = await view.findByText(/^Active · /);
  return description.textContent;
}

test("a goal started only by a schedule names the schedule in its header", async () => {
  const view = open([routine()]);
  expect(await header(view)).toBe("Active · Weekdays at 09:00");
  expect(view.queryByText(/Runs when asked/)).toBeNull();
});

test("a goal with no routines and no events still runs when asked", async () => {
  const view = open([]);
  expect(await header(view)).toBe("Active · Runs when asked");
});

test("a goal whose routines couldn't be read doesn't claim it runs when asked", async () => {
  const view = open(undefined);
  await triggersLoaded();
  // The line under the title says only its state.
  await waitFor(() =>
    expect(
      view
        .getByRole("heading", { level: 1 })
        .parentElement?.parentElement?.querySelector("p")?.textContent,
    ).toBe("Active"),
  );
  fireEvent.click(
    view.getByRole("button", { name: "Delete the goal Watch the queue" }),
  );
  // Schedules may run it that nobody could list, and a delete takes them with it.
  await view.findByText(
    "It stops for good, with its runs and any schedules that run it. You can't undo this.",
  );
});

test("a goal whose only schedule is off says the schedule is off", async () => {
  // An off schedule starts nothing, the same as on the Routines list, where the row says so too.
  const view = open([routine({ enabled: false })]);
  expect(await header(view)).toBe("Active · Schedule off");
});

test("the Active row says schedules start it when the goal has them", async () => {
  const view = open([routine()]);
  await triggersLoaded();
  await view.findByText("Its schedules, events and triggers start it.");
});

test("the Active row says events and triggers start it when the goal has no schedules", async () => {
  const view = open([]);
  await triggersLoaded();
  await view.findByText("Its events and triggers start it.");
});

test("the Active row leaves schedules out when the only schedule is off", async () => {
  const view = open([routine({ enabled: false })]);
  expect(await header(view)).toBe("Active · Schedule off");
  await view.findByText("Its events and triggers start it.");
  expect(view.queryByText(/schedules, events/)).toBeNull();
});

test("a paused goal's schedule rows do not say they start it", async () => {
  const view = open([routine()], "paused");
  await triggersLoaded();
  await view.findByText(
    "Paused. Its schedules, events and triggers won't start it.",
  );
  await view.findByText("Starts it again when you resume it · UTC");
  expect(view.queryByText(/Starts it on a schedule/)).toBeNull();
});

test("an active goal's enabled schedule still starts it on a schedule", async () => {
  const view = open([routine()]);
  await triggersLoaded();
  await view.findByText("Starts it on a schedule · UTC");
  await view.findByText("Its schedules, events and triggers start it.");
});

test("switching a schedule off asks the server to switch that routine off", async () => {
  const view = open([routine()]);
  await triggersLoaded();
  fireEvent.click(
    view.getByRole("switch", { name: "Start it Weekdays at 09:00" }),
  );
  await waitFor(() =>
    expect(sent).toEqual([
      {
        method: "PUT",
        url: "/api/routines/routine-1/enabled",
        body: { enabled: false },
      },
    ]),
  );
});

test("switching an off schedule on asks the server to switch it on", async () => {
  const view = open([routine({ enabled: false })]);
  await triggersLoaded();
  fireEvent.click(
    view.getByRole("switch", { name: "Start it Weekdays at 09:00" }),
  );
  await waitFor(() =>
    expect(sent).toEqual([
      {
        method: "PUT",
        url: "/api/routines/routine-1/enabled",
        body: { enabled: true },
      },
    ]),
  );
});

test("deleting a schedule takes a second press", async () => {
  const view = open([routine()]);
  await triggersLoaded();
  fireEvent.click(
    view.getByRole("button", { name: "Delete the schedule Weekdays at 09:00" }),
  );
  // The first press only asks.
  expect(sent).toEqual([]);
  const confirm = await view.findByRole("button", {
    name: "Confirm deleting the schedule Weekdays at 09:00",
  });
  expect(confirm.textContent).toContain("Delete for good");
  fireEvent.click(confirm);
  await waitFor(() =>
    expect(sent).toStrictEqual([
      { method: "DELETE", url: "/api/routines/routine-1", body: undefined },
    ]),
  );
});

test("a refused change is said under the schedules", async () => {
  const answered = global.fetch;
  global.fetch = Object.assign(
    async (path: Parameters<typeof fetch>[0], init?: RequestInit) =>
      (init?.method ?? "GET") === "GET"
        ? answered(path, init)
        : Response.json(
            { error: "You have 20 routines switched on." },
            { status: 400 },
          ),
    { preconnect: originalFetch.preconnect },
  );
  const view = open([routine({ enabled: false })]);
  await triggersLoaded();
  fireEvent.click(
    view.getByRole("switch", { name: "Start it Weekdays at 09:00" }),
  );
  expect((await view.findByRole("alert")).textContent).toBe(
    "You have 20 routines switched on.",
  );
});

test("a long goal is a page of sections, not a dialog, with nothing started by opening it", async () => {
  const view = open([routine()], "active", {
    progress: Array.from({ length: 12 }, (_, i) => `Step ${i + 1} done.`).join(
      "\n\n",
    ),
    lastResult: "Line one.\n\nLine two.\n\nLine three.",
    subscriptions: [
      { source: "github", eventType: "issues.opened" },
      { source: "github", eventType: "check_run.completed" },
    ],
  });
  await triggersLoaded();
  // A dialog's scrolling body clipped its rounded sections on a short screen; a page has none.
  expect(view.queryByRole("dialog")).toBeNull();
  expect(view.getByRole("heading", { level: 1 }).textContent).toBe(
    "Watch the queue",
  );
  expect(
    view.getAllByRole("heading", { level: 2 }).map((h) => h.textContent),
  ).toEqual([
    "Details",
    "Where it stands",
    "Schedules",
    "Events",
    "Triggers",
    "Runs",
  ]);
  for (const name of [/Run now/, /Complete/, /Open conversation/])
    expect(view.getAllByText(name).length).toBeGreaterThan(0);
  // Each event in words, with the identifier it arrives with under it.
  expect(view.getByText("When a GitHub issue opens")).toBeTruthy();
  expect(view.getByText("GitHub check_run.completed")).toBeTruthy();
  // Opening it starts nothing and saves nothing.
  expect(sent).toEqual([]);
});

test("each schedule says how its last run went, and opens its history", async () => {
  const view = open([
    routine({ lastRun: { status: "failed", at: new Date().toISOString() } }),
  ]);
  await triggersLoaded();
  // The chip its own row on the Routines list had.
  await view.findByText(/^Failed /);
  const history = view.getByRole("button", {
    name: "Run history for the schedule Weekdays at 09:00",
  });
  expect(history.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(history);
  await view.findByText("The queue couldn't be read.");
  expect(view.getByText(/^Scheduled · /)).toBeTruthy();
  expect(history.getAttribute("aria-expanded")).toBe("true");
});

test("Delete, the last row of its actions, asks first, then deletes the goal", async () => {
  const view = open([routine()], "active");
  await triggersLoaded();
  fireEvent.click(
    view.getByRole("button", { name: "Delete the goal Watch the queue" }),
  );
  // The first press only asks.
  await view.findByText('Delete "Watch the queue"?');
  await view.findByText(
    "It stops for good, with its schedules and its runs. You can't undo this.",
  );
  expect(sent).toEqual([]);
  fireEvent.click(view.getByRole("button", { name: "Delete" }));
  await waitFor(() => expect(sent).toHaveLength(1));
  expect(sent).toStrictEqual([
    { method: "DELETE", url: "/api/responsibilities/goal-1", body: undefined },
  ]);
});

test("a refused delete is said in the confirmation, and the confirmation stays", async () => {
  const answered = global.fetch;
  global.fetch = Object.assign(
    async (path: Parameters<typeof fetch>[0], init?: RequestInit) =>
      (init?.method ?? "GET") === "GET"
        ? answered(path, init)
        : new Response(null, { status: 500 }),
    { preconnect: originalFetch.preconnect },
  );
  const view = open([], "active");
  await triggersLoaded();
  fireEvent.click(
    view.getByRole("button", { name: "Delete the goal Watch the queue" }),
  );
  await view.findByText(
    "It stops for good, with its runs. You can't undo this.",
  );
  fireEvent.click(view.getByRole("button", { name: "Delete" }));
  expect((await view.findByRole("alert")).textContent).toBe(
    "Couldn't delete the goal. Try again.",
  );
  expect(
    view.getByRole("dialog", { name: 'Delete "Watch the queue"?' }),
  ).toBeTruthy();
});

test("a goal whose routines couldn't be read says its schedules couldn't be loaded", async () => {
  // A failed read is not "no schedules": the section says so, and the Active row leaves none out.
  const view = open(undefined);
  await triggersLoaded();
  await view.findByText(
    "Couldn't load this goal's schedules. Reload the page.",
  );
  await view.findByText("Its schedules, events and triggers start it.");
});

test("a completed goal's schedules have no switch, and say why", async () => {
  // Completing a goal switches its schedules off, and the server refuses to switch one back on.
  const view = open([routine({ enabled: false })], "completed");
  await triggersLoaded();
  await view.findByText(
    "The goal is completed, so this schedule won't start it again.",
  );
  expect(view.queryByRole("switch")).toBeNull();
  // What is left to do with it: its history, and Delete.
  expect(
    view.getByRole("button", {
      name: "Run history for the schedule Weekdays at 09:00",
    }),
  ).toBeTruthy();
  expect(
    view.getByRole("button", { name: "Delete the schedule Weekdays at 09:00" }),
  ).toBeTruthy();
});
