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
import { cleanup, render, waitFor } from "@testing-library/react";
import { ResponsibilityDialog } from "@/components/responsibilities/responsibility-dialog";
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
  endsWhenMet: false,
  updatedAt: "2026-11-10T10:00:00Z",
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
  routines: RoutineRecord[],
  status: ResponsibilityRecord["status"] = "active",
) {
  const root = createRootRoute();
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: root.addChildren([
      createRoute({
        getParentRoute: () => root,
        path: "/",
        component: () => (
          <ResponsibilityDialog
            goal={{ ...goal, status }}
            onClose={() => {}}
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

/** Resolves once the goal's triggers request has been answered, so nothing below reads a half-loaded dialog. */
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

test("a goal whose only schedule is off runs when asked", async () => {
  // An off schedule starts nothing, the same as on the Routines list, where it is left out of the row.
  const view = open([routine({ enabled: false })]);
  expect(await header(view)).toBe("Active · Runs when asked");
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
  expect(await header(view)).toBe("Active · Runs when asked");
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
