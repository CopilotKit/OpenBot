import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import {
  cleanup,
  fireEvent,
  render,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NewRoutineMenu } from "@/components/routines/new-routine-button";
import { RoutinesList } from "@/components/routines/routines-list";
import { mergeRoutines } from "@/lib/routines/merged";
import type { RoutineRecord } from "@/lib/routines/queries";
import { Route as BotGoalsRoute } from "@/routes/_authed/_app/bots.$agentId.responsibilities";
import { Route as RoutinesRoute } from "@/routes/_authed/_app/routines";
import { settleReactWork } from "./settle-react-work";

/**
 * A Bot's Routines: its routines, its goals and its check-ins as one list, each row the same
 * sentence (what, starts, does, until), and New offering each kind.
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
    if (url === "/api/routines")
      return Response.json({
        routines,
        sweep: { lastSweptAt: new Date().toISOString(), working: true },
      });
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
          <NewRoutineMenu agentId={agentId} />
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

test("New offers a routine, a goal and a check-in, and a new goal needs no Bot picked", async () => {
  serving();
  const view = draw();
  await view.findByText("Reconcile receipts");
  const user = userEvent.setup({ document });
  await user.click(view.getByRole("button", { name: /^New/ }));
  const menu = await view.findByRole("menu");
  expect(
    within(menu)
      .getAllByRole("menuitem")
      .map((item) => item.textContent),
  ).toEqual(["Routine", "Goal", "Check-in"]);
  expect(menu.textContent).toContain("Or ask a Bot");
  await user.click(within(menu).getByRole("menuitem", { name: "Goal" }));

  expect(view.queryByRole("combobox", { name: /^Bot/ })).toBeNull();
  await user.click(view.getByRole("combobox", { name: /^Conversation/ }));
  const options = (await view.findAllByRole("option")).map(
    (option) => option.textContent,
  );
  expect(options).toContain("Finance desk");
  expect(options).not.toContain("Docs desk");

  await user.click(view.getByRole("option", { name: "Finance desk" }));
  await user.type(view.getByLabelText("Title"), "Close the month");
  await user.type(view.getByLabelText("Instruction"), "Close it.");
  await user.type(view.getByLabelText("Success criteria"), "Closed.");
  fireEvent.submit(
    (view.getByRole("button", { name: /Create/ }) as HTMLButtonElement)
      .form as HTMLFormElement,
  );
  await waitFor(() =>
    expect(writes.map((write) => write.body)).toContainEqual(
      expect.objectContaining({
        agentId: "expenses",
        channelId: "channel-expenses",
        title: "Close the month",
      }),
    ),
  );
});

test("a Bot that already checks in is offered no second check-in", async () => {
  serving({ checkIns: [checkIn("c1", "expenses", "The launch brief")] });
  const view = draw();
  await view.findByText("The launch brief");
  const user = userEvent.setup({ document });
  await user.click(view.getByRole("button", { name: /^New/ }));
  const menu = await view.findByRole("menu");
  expect(
    within(menu)
      .getAllByRole("menuitem")
      .map((item) => item.textContent),
  ).toEqual(["Routine", "Goal"]);
});

test("the empty list says routines are made by asking, with one of each kind", async () => {
  serving({ goals: [] });
  const view = draw();
  expect(await view.findByText("No routines for this Bot yet")).toBeTruthy();
  const said = document.body.textContent ?? "";
  expect(said).toContain("Ask a Bot");
  expect(said).toMatch(/is a routine\./);
  expect(said).toMatch(/is a goal\./);
  expect(said).toMatch(/is a check-in\./);
  // One word for one thing: the route and the API say responsibilities, the person never does.
  expect(said).not.toMatch(/responsibilit/i);
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
