import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  environmentManager,
  QueryClient,
  QueryClientProvider,
  type TimeoutCallback,
  timeoutManager,
} from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { GoalRoutePage } from "@/components/responsibilities/goal-page";
import { RoutinesList } from "@/components/routines/routines-list";
import type { ResponsibilityRecord } from "@/lib/responsibilities";
import {
  ROUTINES_REFETCH_MS,
  type RoutineRecord,
} from "@/lib/routines/queries";
import { settleReactWork } from "./settle-react-work";

/**
 * The Routines list and a goal's page while they stay open: what changes on the server without
 * this screen (a run completes a goal and the server switches its schedule off, a Bot gives a goal a
 * schedule) reaches them within one interval, with no remount.
 *
 * The intervals are TanStack Query's own timers, moved by hand through its `timeoutManager`: only
 * the query's polls are held, and everything else (React, testing-library's waits) keeps real time.
 */

/** Query intervals by id, run by `advance` rather than by the clock. */
const intervals = new Map<
  number,
  { callback: TimeoutCallback; delay: number }
>();
let nextInterval = 1;

/** Moves the query clock on by `ms`: each interval that falls due runs. */
function advance(ms: number) {
  for (const { callback, delay } of [...intervals.values()])
    if (delay <= ms) callback();
}

let wasServer = true;
beforeAll(() => {
  GlobalRegistrator.register();
  wasServer = environmentManager.isServer();
  environmentManager.setIsServer(() => false);
  timeoutManager.setTimeoutProvider({
    setTimeout: (callback, delay) =>
      setTimeout(callback, delay) as unknown as number,
    clearTimeout: (id) => clearTimeout(id as number),
    setInterval: (callback, delay) => {
      const id = nextInterval++;
      intervals.set(id, { callback, delay });
      return id;
    },
    clearInterval: (id) => {
      intervals.delete(id as number);
    },
  });
});
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  timeoutManager.setTimeoutProvider({
    setTimeout: (callback, delay) =>
      setTimeout(callback, delay) as unknown as number,
    clearTimeout: (id) => clearTimeout(id as number),
    setInterval: (callback, delay) =>
      setInterval(callback, delay) as unknown as number,
    clearInterval: (id) => clearInterval(id as number),
  });
  environmentManager.setIsServer(() => wasServer);
  GlobalRegistrator.unregister();
});

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
});

const goal = (
  overrides: Partial<ResponsibilityRecord> = {},
): ResponsibilityRecord => ({
  id: "g1",
  agentId: "expenses",
  channelId: "channel-expenses",
  threadId: "thread",
  title: "Reconcile receipts",
  instruction: "Do it.",
  successCriteria: "The receipts match the bank.",
  status: "active",
  progress: "",
  lastResult: null,
  subscriptions: [],
  recurring: false,
  endsWhenMet: true,
  updatedAt: "2026-10-09T10:00:00Z",
  ...overrides,
});

const routine = (overrides: Partial<RoutineRecord> = {}): RoutineRecord => ({
  id: "r1",
  agentId: "expenses",
  schedule: "Weekdays at 09:00",
  timezone: "UTC",
  instruction: 'Run the goal "Reconcile receipts" (g1) with run_goal.',
  title: "Reconcile receipts",
  channel: {
    id: "channel-expenses",
    name: null,
    title: "Finance",
    gone: false,
  },
  enabled: true,
  nextRunAt: "2999-01-01T09:00:00.000Z",
  lastRun: null,
  goalId: "g1",
  ...overrides,
});

/** What the server holds now. A test changes it, as a run or a Bot would, between polls. */
const server = {
  goals: [] as ResponsibilityRecord[],
  routines: [] as RoutineRecord[] | "fails",
};

function serving() {
  global.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = String(input);
      if ((init?.method ?? "GET") !== "GET") return Response.json({});
      if (url === "/api/responsibilities")
        return Response.json({ responsibilities: server.goals });
      if (url === "/api/routines")
        return server.routines === "fails"
          ? new Response(null, { status: 500 })
          : Response.json({
              routines: server.routines,
              sweep: { lastSweptAt: new Date().toISOString(), working: true },
            });
      if (url === "/api/proactive/settings")
        return Response.json({ settings: [], allowed: true });
      if (url.startsWith("/api/agents"))
        return Response.json({
          agents: [{ id: "expenses", name: "Expenses" }],
        });
      return Response.json({ runs: [], triggers: [], channels: [] });
    },
    { preconnect: originalFetch.preconnect },
  );
}

/** Draws `page` alone, with a client of its own that doesn't retry. */
function draw(page: () => ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: createRootRoute({ component: page }),
  });
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

test("the Routines list reads routines again at the goals' interval, so a goal's row follows the server", async () => {
  server.goals = [goal()];
  server.routines = [];
  serving();
  const view = draw(() => <RoutinesList agentId="expenses" />);
  const row = (await view.findByText("Reconcile receipts")).closest(
    "a",
  ) as HTMLElement;
  await waitFor(() => expect(row.textContent).toContain("When you ask"));

  // A Bot gives the goal a schedule. Goals were read again every interval; routines were not, so
  // the row said "When you ask" until the page was opened again.
  server.routines = [routine()];
  await act(async () => advance(ROUTINES_REFETCH_MS));
  await waitFor(() => expect(row.textContent).toContain("Weekdays at 09:00"));
});

test("a goal's page follows its schedules while it is open", async () => {
  server.goals = [goal()];
  server.routines = [];
  serving();
  const view = draw(() => <GoalRoutePage agentId="expenses" goalId="g1" />);
  await view.findByRole("heading", { level: 1, name: "Reconcile receipts" });
  await waitFor(() =>
    expect(view.queryByText("Its events and triggers start it.")).toBeTruthy(),
  );

  // A Bot gives it a schedule while the page is open.
  server.routines = [routine()];
  await act(async () => advance(ROUTINES_REFETCH_MS));
  await view.findByText("Starts it on a schedule · UTC");
  expect(
    view
      .getByRole("switch", { name: "Start it Weekdays at 09:00" })
      .getAttribute("aria-checked"),
  ).toBe("true");

  // Its run meets the outcome: the goal completes, and the server switches its schedule off.
  server.goals = [goal({ status: "completed" })];
  server.routines = [routine({ enabled: false })];
  await act(async () => advance(ROUTINES_REFETCH_MS));
  await view.findByText(
    "The goal is completed, so this schedule won't start it again.",
  );
  expect(view.queryByText("Starts it on a schedule · UTC")).toBeNull();
  expect(view.queryByRole("switch")).toBeNull();
});
