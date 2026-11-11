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
import { NewRoutineButton } from "@/components/routines/new-routine-button";
import { RoutinesList } from "@/components/routines/routines-list";
import { mergeRoutines } from "@/lib/routines/merged";
import type { RoutineRecord } from "@/lib/routines/queries";
import { Route as BotGoalsRoute } from "@/routes/_authed/_app/bots.$agentId.responsibilities";
import { Route as RoutinesRoute } from "@/routes/_authed/_app/routines";
import { settleReactWork } from "./settle-react-work";

/**
 * A Bot's Routines: its routines, its goals and its check-ins as one list, each row the same
 * sentence (what, starts, does, until), and one New routine button.
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

const goal = (id: string, agentId: string, title: string) => ({
  id,
  agentId,
  channelId: `channel-${agentId}`,
  threadId: "thread",
  title,
  instruction: "Do it.",
  successCriteria: "The receipts match the bank.",
  status: "active" as const,
  progress: "",
  lastResult: null,
  subscriptions: [],
  endsWhenMet: false,
  updatedAt: "2026-10-09T10:00:00Z",
});

const routine = (
  id: string,
  agentId: string,
  overrides: Partial<RoutineRecord> = {},
): RoutineRecord => ({
  id,
  agentId,
  schedule: "Weekdays at 09:00",
  timezone: "UTC",
  instruction: "Post the standup summary.",
  title: null,
  channel: { id: "channel-1", name: null, title: "Standup", gone: false },
  enabled: true,
  nextRunAt: "2999-01-01T09:00:00.000Z",
  lastRun: null,
  goalId: null,
  ...overrides,
});

const checkIn = (id: string, agentId: string, subject: string) => ({
  id,
  agentId,
  channelId: `channel-${agentId}`,
  focus: "",
  subject,
  enabled: true,
  intervalMinutes: 1440,
  nextRunAt: "2999-01-01T09:00:00.000Z",
  lastRunAt: null,
  lastStatus: "idle" as const,
  lastError: null,
  lastRun: null,
});

const channel = (id: string, name: string, agentIds: string[]) => ({
  id,
  name,
  agentIds,
  active: true,
  summary: null,
  lastMessage: null,
  lastMessageAgentId: null,
  createdAt: "2026-10-09T10:00:00Z",
  pinned: false,
  lastReadAt: null,
});

const writes: { request: string; body: unknown }[] = [];
function serving({
  goals = [
    goal("g1", "expenses", "Reconcile receipts"),
    goal("g2", "knowledge", "Keep the wiki fresh"),
  ],
  routines = [] as RoutineRecord[],
  checkIns = [] as ReturnType<typeof checkIn>[],
  working = true,
  routinesFail = false,
} = {}) {
  writes.length = 0;
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (method !== "GET") {
      writes.push({
        request: `${method} ${url}`,
        body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
      });
      return Response.json({ ok: true });
    }
    if (url === "/api/responsibilities")
      return Response.json({ responsibilities: goals });
    if (url === "/api/routines") {
      if (routinesFail) return new Response(null, { status: 500 });
      return Response.json({
        routines,
        sweep: { lastSweptAt: new Date().toISOString(), working },
      });
    }
    if (url === "/api/proactive/settings")
      return Response.json({ settings: checkIns, allowed: true });
    if (url.startsWith("/api/channels")) {
      return Response.json({
        channels: [
          channel("channel-expenses", "Finance desk", ["expenses"]),
          channel("channel-knowledge", "Docs desk", ["knowledge"]),
        ],
        nextCursor: null,
      });
    }
    if (url.startsWith("/api/agents")) {
      return Response.json({
        agents: [
          { id: "expenses", name: "Expenses" },
          { id: "knowledge", name: "Knowledge" },
        ],
      });
    }
    return Response.json({ runs: [], triggers: [], requests: [] });
  }) as unknown as typeof fetch;
}

function draw(agentId: string | undefined = "expenses") {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: createRootRoute({
      component: () => (
        <>
          <NewRoutineButton agentId={agentId} />
          <RoutinesList agentId={agentId} />
        </>
      ),
    }),
  });
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

test("only this Bot's goals are listed, each as a goal with its outcome", async () => {
  serving();
  const view = draw();
  const title = await view.findByText("Reconcile receipts");
  const row = title.closest("button") as HTMLElement;
  expect(within(row).getByText("Goal")).toBeTruthy();
  expect(
    within(row).getByText("Until: The receipts match the bank."),
  ).toBeTruthy();
  expect(view.queryByText("Keep the wiki fresh")).toBeNull();
});

test("a routine, a goal and a check-in are one list, each in four parts", async () => {
  serving({
    routines: [routine("r1", "expenses")],
    checkIns: [checkIn("c1", "expenses", "The launch brief")],
  });
  const view = draw();
  // A routine: what it does, when it starts, and that it acts.
  expect(await view.findByText("Post the standup summary.")).toBeTruthy();
  expect(view.getByText("Weekdays at 09:00 · UTC · Acts")).toBeTruthy();
  // A goal, as above.
  expect(view.getByText("Reconcile receipts")).toBeTruthy();
  // A check-in: what it watches, how often, and that it only tells you.
  const checkInRow = view
    .getByText("The launch brief")
    .closest("button") as HTMLElement;
  expect(within(checkInRow).getByText("Check-in")).toBeTruthy();
  expect(checkInRow.textContent).toContain("Once a day · Tells you");
  // One list: no heading names a kind.
  expect(view.queryByRole("heading", { name: /Goals|Check-ins/ })).toBeNull();
});

test("a routine that runs a goal is one of that goal's starts, not a row of its own", async () => {
  serving({
    routines: [
      routine("r1", "expenses", {
        schedule: "Every day at 08:00",
        instruction: "Run the goal.",
        goalId: "g1",
      }),
    ],
  });
  const view = draw();
  const row = (await view.findByText("Reconcile receipts")).closest(
    "button",
  ) as HTMLElement;
  expect(row.textContent).toContain("Every day at 08:00");
  expect(view.queryByText("Run the goal.")).toBeNull();
});

test("a stopped worker is said when the only schedule is a goal's", async () => {
  serving({
    working: false,
    routines: [routine("r1", "expenses", { goalId: "g1" })],
  });
  const view = draw();
  await view.findByText("Reconcile receipts");
  expect(view.getByText("Routines aren't running.")).toBeTruthy();
});

test("a goal's row claims no start when routines couldn't be read", async () => {
  serving({ routinesFail: true });
  const view = draw();
  const row = (await view.findByText("Reconcile receipts")).closest(
    "button",
  ) as HTMLElement;
  await view.findByText("Couldn't load your routines. Reload the page.");
  expect(row.textContent).not.toContain("When you ask");
});

test("New routine opens the create screen for this Bot", async () => {
  serving();
  const view = draw();
  await view.findByText("Reconcile receipts");
  const buttons = view.getAllByRole("button", { name: "New routine" });
  expect(buttons.length).toBeGreaterThan(0);
  for (const button of buttons) {
    expect(button.getAttribute("href")).toBe("/routines/new?agentId=expenses");
  }
});

test("New offers no kinds", async () => {
  serving();
  const view = draw();
  await view.findByText("Reconcile receipts");
  expect(
    view.queryAllByRole("menuitem", { name: /^(Goal|Check-in)$/ }),
  ).toHaveLength(0);
  expect(
    view.queryAllByRole("button", { name: /^(Goal|Check-in)$/ }),
  ).toHaveLength(0);
});

test("the empty state gives one example and one way in", async () => {
  serving({ goals: [] });
  const view = draw();
  expect(await view.findByText("No routines for this Bot yet")).toBeTruthy();
  expect(document.body.textContent ?? "").toContain(
    "Make one with New routine, like “every weekday at 9, send me yesterday's new leads”. Or ask a Bot in a conversation.",
  );
  expect(
    view.getAllByRole("button", { name: "New routine" }).length,
  ).toBeGreaterThan(0);
});

function redirectOf(route: { options: { beforeLoad?: unknown } }, input = {}) {
  try {
    (route.options.beforeLoad as (input: unknown) => void)(input);
  } catch (thrown) {
    return (thrown as { options?: { to?: string; params?: unknown } }).options;
  }
  return undefined;
}

test("the old Routines and Goals addresses open the Routines lists", () => {
  expect(redirectOf(RoutinesRoute as never)?.to).toBe("/settings/routines");
  expect(
    redirectOf(BotGoalsRoute as never, { params: { agentId: "expenses" } }),
  ).toMatchObject({
    to: "/bots/$agentId/routines",
    params: { agentId: "expenses" },
  });
});

test("merging keeps a routine whose goal is not listed, and puts working rows first", () => {
  const rows = mergeRoutines({
    routines: [
      routine("paused", "a", { enabled: false }),
      routine("orphan", "a", { goalId: "gone" }),
    ],
    goals: [goal("g1", "a", "Goal")],
    checkIns: [checkIn("c1", "a", "Inbox")],
  });
  expect(rows.map((row) => `${row.kind}:${row.id}`)).toEqual([
    "routine:orphan",
    "goal:g1",
    "check-in:c1",
    "routine:paused",
  ]);
});
