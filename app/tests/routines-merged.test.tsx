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
import {
  cleanup,
  fireEvent,
  render,
  waitFor,
  within,
} from "@testing-library/react";
import { NewRoutineButton } from "@/components/routines/new-routine-button";
import {
  RoutineRoutePage,
  scheduleWords,
} from "@/components/routines/routine-page";
import { RoutinesList } from "@/components/routines/routines-list";
import { mergeRoutines } from "@/lib/routines/merged";
import type { RoutineRecord } from "@/lib/routines/queries";
import { Route as BotGoalsRoute } from "@/routes/_authed/_app/bots.$agentId.responsibilities";
import { Route as ResponsibilitiesRoute } from "@/routes/_authed/_app/responsibilities";
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
  recurring: false,
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
  goalsFail = false,
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
      return goalsFail
        ? new Response(null, { status: 500 })
        : Response.json({ responsibilities: goals });
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

/** `null` is the every-Bot Routines page. */
function draw(scope: string | null = "expenses") {
  const agentId = scope ?? undefined;
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  // The list, and the page each schedule's row links to, as the app routes them.
  const root = createRootRoute({ component: Outlet });
  const schedule = createRoute({
    getParentRoute: () => root,
    path: "/routines/schedules/$routineId",
    component: function SchedulePage() {
      const { routineId } = schedule.useParams();
      return <RoutineRoutePage agentId={agentId} routineId={routineId} />;
    },
  });
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: root.addChildren([
      createRoute({
        getParentRoute: () => root,
        path: "/",
        component: () => (
          <>
            <NewRoutineButton agentId={agentId} />
            <RoutinesList agentId={agentId} />
          </>
        ),
      }),
      schedule,
      createRoute({
        getParentRoute: () => root,
        path: "/bots/$agentId/routines",
        component: () => <RoutinesList agentId={agentId} />,
      }),
    ]),
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
  const row = title.closest("a, button") as HTMLElement;
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
  expect(
    view.getByText(
      `${scheduleWords({ schedule: "Weekdays at 09:00", timezone: "UTC" })} · Acts`,
    ),
  ).toBeTruthy();
  // A goal, as above.
  expect(view.getByText("Reconcile receipts")).toBeTruthy();
  // A check-in: what it watches, how often, and that it only tells you.
  const checkInRow = view
    .getByText("The launch brief")
    .closest("a, button") as HTMLElement;
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
    "a, button",
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
    "a, button",
  ) as HTMLElement;
  await view.findByText("Couldn't load your routines. Reload the page.");
  expect(row.textContent).not.toContain("When you ask");
});

test("a routine that runs a goal, on a row of its own, says so and never shows the model's instruction", async () => {
  // Its goal isn't in the goals read (here the read failed), so the routine is a row of its own.
  serving({
    goalsFail: true,
    routines: [
      routine("r1", "expenses", {
        goalId: "g1",
        title: "Reconcile receipts",
        instruction:
          'Run the goal "Reconcile receipts" (5f1c2d9e-0000-4000-8000-000000000001) with run_goal.',
      }),
      routine("r2", "expenses", {
        goalId: "g2",
        title: null,
        schedule: "Every day at 08:00",
        instruction:
          'Run the goal "A goal named past the routine title limit" (5f1c2d9e-0000-4000-8000-000000000002) with run_goal.',
      }),
    ],
  });
  const view = draw();
  await view.findByText("Couldn't load your goals. Reload the page.");
  // Named: the goal's title, as New routine names its routine, and what it does under it.
  const named = (await view.findByText("Reconcile receipts")).closest(
    '[data-slot="item"]',
  ) as HTMLElement;
  expect(within(named).getByText("Runs a goal")).toBeTruthy();
  // Unnamed: what it does heads its own row.
  const unnamed = view
    .getAllByText("Runs a goal")
    .map((words) => words.closest('[data-slot="item"]'))
    .find((item) => item !== named) as HTMLElement;
  expect(unnamed.textContent).toContain("Schedule");
  expect(document.body.textContent).not.toContain("run_goal");
  // Its page says the same, in its title and nowhere the instruction.
  fireEvent.click(unnamed.closest("a") as HTMLElement);
  await view.findByRole("heading", { level: 1, name: "Runs a goal" });
  expect(document.body.textContent).not.toContain("run_goal");
});

/** The row of the goal titled `title`, once its starts are on it. */
async function goalRow(
  view: ReturnType<typeof draw>,
  title: string,
  starts: RegExp,
) {
  // A link to the goal's page.
  const row = (await view.findByText(title)).closest("a") as HTMLElement;
  await waitFor(() => expect(row.textContent).toMatch(starts));
  return row;
}

test("a goal that repeats never says until when, and one that can end does", async () => {
  serving({
    goals: [
      { ...goal("g1", "expenses", "Recurring"), recurring: true },
      {
        ...goal("g2", "expenses", "On events"),
        subscriptions: [{ source: "github", eventType: "issues.opened" }],
      },
      goal("g3", "expenses", "On a schedule"),
      goal("g4", "expenses", "Switched off"),
      {
        ...goal("g5", "expenses", "Ends when met"),
        endsWhenMet: true,
      },
      goal("g6", "expenses", "Once"),
    ] as unknown as ReturnType<typeof goal>[],
    routines: [
      routine("r3", "expenses", { goalId: "g3" }),
      routine("r4", "expenses", { goalId: "g4", enabled: false }),
      routine("r5", "expenses", { goalId: "g5" }),
    ],
  });
  const view = draw();
  const until = "Until: The receipts match the bank.";
  for (const [title, starts] of [
    ["Recurring", /When you ask/],
    ["On events", /When a GitHub issue opens/],
    ["On a schedule", /Weekdays at 09:00/],
  ] as const)
    expect((await goalRow(view, title, starts)).textContent).not.toContain(
      until,
    );
  for (const [title, starts] of [
    ["Switched off", /Schedule off/],
    ["Ends when met", /Weekdays at 09:00/],
    ["Once", /When you ask/],
  ] as const)
    expect((await goalRow(view, title, starts)).textContent).toContain(until);
});

test("a goal whose only schedule is off says so, not that it runs when you ask", async () => {
  serving({
    routines: [routine("r1", "expenses", { goalId: "g1", enabled: false })],
  });
  const view = draw();
  const row = await goalRow(view, "Reconcile receipts", /Schedule off/);
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
    "Like “every weekday at 9, send me yesterday's new leads”. Or ask a Bot in a conversation.",
  );
  expect(document.body.textContent ?? "").not.toContain(
    "Make one with New routine",
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
  expect(redirectOf(ResponsibilitiesRoute as never)?.to).toBe("/routines");
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

test("while the list loads it draws the list's shape, never the empty state", async () => {
  serving({ goals: [] });
  const served = global.fetch;
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    await gate;
    return served(input, init);
  }) as typeof fetch;
  const view = draw();
  expect(
    await view.findByRole("status", { name: "Loading your routines" }),
  ).toBeTruthy();
  expect(view.queryByText("No routines for this Bot yet")).toBeNull();

  release();
  expect(await view.findByText("No routines for this Bot yet")).toBeTruthy();
  expect(
    view.queryByRole("status", { name: "Loading your routines" }),
  ).toBeNull();
});

test("a goal's row is a link to the goal's own page, back to the Bot's list it came from", async () => {
  serving();
  const view = draw();
  const row = (await view.findByText("Reconcile receipts")).closest(
    "a",
  ) as HTMLAnchorElement;
  expect(row).not.toBeNull();
  const href = new URL(row.href, "http://localhost");
  expect(href.pathname).toMatch(/^\/routines\/goals\/[^/]+$/);
  expect(href.searchParams.get("agentId")).toBe("expenses");
  // A page, not a dialog over the list.
  expect(within(document.body).queryByRole("dialog")).toBeNull();
});

/*
 * One row shape for every kind: a schedule opens its details as a goal and a check-in do, and
 * everything its row used to carry inline is there.
 */
async function openSchedule(view: ReturnType<typeof draw>) {
  const row = (await view.findByText("Post the standup summary.")).closest(
    "a",
  ) as HTMLElement;
  fireEvent.click(row);
  // Its own page, not a dialog over the list.
  await view.findByRole("heading", {
    level: 1,
    name: "Post the standup summary.",
  });
  expect(within(document.body).queryByRole("dialog")).toBeNull();
  return document.body;
}

test("every kind of row is one link or button with a chevron, with no control inside it", async () => {
  serving({
    routines: [routine("r1", "expenses")],
    checkIns: [checkIn("c1", "expenses", "The launch brief")],
  });
  const view = draw();
  await view.findByText("Post the standup summary.");
  for (const text of [
    "Post the standup summary.",
    "Reconcile receipts",
    "The launch brief",
  ]) {
    const row = view.getByText(text).closest("a, button") as HTMLElement;
    expect(row).not.toBeNull();
    expect(row.querySelector("button, a, input, [role=switch]")).toBeNull();
    expect(row.querySelector(".tabler-icon-chevron-right")).not.toBeNull();
  }
  expect(view.queryByRole("switch")).toBeNull();
  expect(view.queryByRole("button", { name: /^Delete/ })).toBeNull();
});

test("a schedule's page pauses it, runs it, shows its runs and deletes it", async () => {
  serving({ routines: [routine("r1", "expenses")] });
  const view = draw();
  const details = within(await openSchedule(view));
  expect(details.getByText("UTC")).toBeTruthy();

  fireEvent.click(
    details.getByRole("switch", {
      name: "Enable the routine scheduled Weekdays at 09:00",
    }),
  );
  await waitFor(() =>
    expect(writes).toContainEqual({
      request: "PUT /api/routines/r1/enabled",
      body: { enabled: false },
    }),
  );

  fireEvent.click(
    details.getByRole("button", {
      name: "Run the routine scheduled Weekdays at 09:00 now",
    }),
  );
  await waitFor(() =>
    expect(writes.map((write) => write.request)).toContain(
      "POST /api/routines/r1/run",
    ),
  );
  // Its runs are on the page, so the one Run now started appears there.
  expect(details.getByRole("heading", { name: "Runs" })).toBeTruthy();

  fireEvent.click(
    details.getByRole("button", {
      name: "Delete the routine scheduled Weekdays at 09:00",
    }),
  );
  // Delete still asks first.
  const confirm = await within(document.body).findByRole("dialog", {
    name: "Delete “Post the standup summary.”?",
  });
  expect(writes.map((write) => write.request)).not.toContain(
    "DELETE /api/routines/r1",
  );
  fireEvent.click(within(confirm).getByRole("button", { name: "Delete" }));
  await waitFor(() =>
    expect(writes.map((write) => write.request)).toContain(
      "DELETE /api/routines/r1",
    ),
  );
  // Deleted, it goes back to the Bot's list it came from.
  await waitFor(() =>
    expect(
      view.queryByRole("heading", {
        level: 1,
        name: "Post the standup summary.",
      }),
    ).toBeNull(),
  );
});

test("a refused delete is said in its confirmation, and Delete can be pressed again", async () => {
  serving({ routines: [routine("r1", "expenses")] });
  const served = global.fetch;
  let refuse = true;
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "DELETE" && refuse)
      return Response.json({ error: "Couldn't delete it." }, { status: 500 });
    return served(input, init);
  }) as typeof fetch;
  const view = draw();
  const details = within(await openSchedule(view));
  fireEvent.click(
    details.getByRole("button", {
      name: "Delete the routine scheduled Weekdays at 09:00",
    }),
  );
  const confirm = within(
    await within(document.body).findByRole("dialog", {
      name: "Delete “Post the standup summary.”?",
    }),
  );
  fireEvent.click(confirm.getByRole("button", { name: "Delete" }));
  expect((await confirm.findByRole("alert")).textContent).toBe(
    "Couldn't delete it.",
  );

  refuse = false;
  fireEvent.click(confirm.getByRole("button", { name: "Delete" }));
  await waitFor(() =>
    expect(writes.map((write) => write.request)).toContain(
      "DELETE /api/routines/r1",
    ),
  );
});

test("a skipped last run is on the row, and a quiet success is not", async () => {
  serving({
    routines: [
      routine("r1", "expenses", {
        lastRun: { status: "skipped", at: new Date().toISOString() },
      }),
      routine("r2", "expenses", {
        instruction: "Send the digest.",
        lastRun: { status: "succeeded", at: new Date().toISOString() },
      }),
    ],
  });
  const view = draw();
  const skipped = (await view.findByText("Post the standup summary.")).closest(
    "a, button",
  ) as HTMLElement;
  expect(within(skipped).getByText(/^Skipped /)).toBeTruthy();
  const quiet = view
    .getByText("Send the digest.")
    .closest("a, button") as HTMLElement;
  expect(within(quiet).queryByText(/^Ran /)).toBeNull();
});

test("on the every-Bot list a schedule's row names its Bot, and its page leads to that Bot", async () => {
  serving({ goals: [], routines: [routine("r1", "expenses")] });
  const view = draw(null);
  expect(await view.findByText(/^Expenses · Weekdays at 09:00/)).toBeTruthy();
  const details = within(await openSchedule(view));
  expect(
    details.getByRole("link", { name: /Expenses/ }).getAttribute("href"),
  ).toBe("/bots/expenses/routines");
});
