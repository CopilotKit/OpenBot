import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, within } from "@testing-library/react";
import { BotRoutinesSection } from "@/components/routines/bot-routines";
import type { BotActivity } from "@/lib/bot-lifecycle/queries";
import type { ProactiveSetting } from "@/lib/proactive";
import type { ResponsibilityRecord } from "@/lib/responsibilities";
import {
  countRoutines,
  routineCountsLine,
  routinesOn,
} from "@/lib/routines/bot-routines";
import { mergeRoutines } from "@/lib/routines/merged";
import type { RoutineRecord } from "@/lib/routines/queries";
import { queryClient } from "@/query-client";
import { settleReactWork } from "./settle-react-work";

/**
 * A Bot's page lists what it does by itself, read from the rows its Routines page draws: each
 * routine, goal and check-in that is on, running ones first, at most five, then All routines.
 * FOUND IN AN AUDIT: a Bot whose only standing work was a check-in read "No tasks, routines or goals
 * yet", and people asked for a summary of a Bot's running routines on its page.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(() => {
  cleanup();
  queryClient.clear();
});
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const soon = (hours: number) =>
  new Date(Date.now() + hours * 3_600_000).toISOString();

const routine = (
  id: string,
  overrides: Partial<RoutineRecord> = {},
): RoutineRecord => ({
  id,
  agentId: "scout",
  schedule: "Every weekday at 9:00",
  timezone: "UTC",
  instruction: `Do ${id}`,
  title: id,
  channel: { id: "c", name: null, title: null, gone: false },
  enabled: true,
  nextRunAt: soon(5),
  lastRun: { status: "succeeded", at: soon(-2) },
  goalId: null,
  ...overrides,
});
const goal = (
  id: string,
  overrides: Partial<ResponsibilityRecord> = {},
): ResponsibilityRecord => ({
  id,
  agentId: "scout",
  channelId: "c",
  threadId: "t",
  title: id,
  instruction: id,
  successCriteria: "",
  status: "active",
  progress: "",
  lastResult: null,
  subscriptions: [],
  recurring: false,
  endsWhenMet: false,
  updatedAt: soon(-1),
  ...overrides,
});
const checkIn = (
  id: string,
  overrides: Partial<ProactiveSetting> = {},
): ProactiveSetting => ({
  id,
  agentId: "scout",
  channelId: null,
  focus: "",
  subject: id,
  sourceKind: "app",
  reads: "Gmail",
  enabled: true,
  intervalMinutes: 1440,
  nextRunAt: soon(3),
  lastRunAt: null,
  lastStatus: "idle",
  lastError: null,
  lastRun: null,
  health: null,
  ...overrides,
});
const activity = (onDemand: string[] = []): BotActivity =>
  ({
    inProgress: [],
    scheduled: [],
    onDemand: onDemand.map((id) => ({
      id: `responsibility:${id}`,
      kind: "responsibility",
      title: id,
      detail: "Runs when asked",
      status: "active",
      at: soon(-1),
      channelId: "c",
      needsYou: false,
      stoppable: false,
      cancellable: false,
    })),
    completed: [],
  }) as BotActivity;

test("only what is on, running first, then what needs a look, then by what starts next, then goals that wait to be asked", () => {
  const rows = mergeRoutines({
    routines: [
      routine("Later", { nextRunAt: soon(10) }),
      routine("Sooner", { nextRunAt: soon(1) }),
      routine("Running", { lastRun: { status: null, at: null } }),
      routine("Broken", { lastRun: { status: "failed", at: soon(-1) } }),
      routine("Off", { enabled: false }),
      // A routine that runs a goal is that goal's row.
      routine("Runs the report", { goalId: "Report", nextRunAt: soon(2) }),
    ],
    goals: [
      goal("Report"),
      goal("Asked"),
      goal("Done", { status: "completed" }),
    ],
    checkIns: [checkIn("Inbox"), checkIn("Quiet", { enabled: false })],
    agentId: "scout",
  });
  const on = routinesOn(rows, activity(["Asked"]));
  expect(on.map(({ row }) => row.id)).toEqual([
    "Running",
    "Broken",
    "Sooner",
    "Report",
    "Inbox",
    "Later",
    "Asked",
  ]);
  const counts = countRoutines(on);
  expect(counts).toEqual({ running: 1, scheduled: 5, onDemand: 1 });
  expect(routineCountsLine(counts)).toBe(
    "1 running · 5 scheduled · 1 on demand",
  );
  expect(routineCountsLine({ running: 0, scheduled: 1, onDemand: 0 })).toBe(
    "1 scheduled",
  );
});

/** The Bot's page, with the three reads the Routines page makes and the Bot's activity served. */
function drawn(data: {
  routines?: RoutineRecord[];
  goals?: ResponsibilityRecord[];
  checkIns?: ProactiveSetting[];
  onDemand?: string[];
  paused?: boolean;
}) {
  global.fetch = (async (input: RequestInfo | URL) => {
    const path = String(input);
    if (path === "/api/routines")
      return Response.json({
        routines: data.routines ?? [],
        sweep: { lastSweptAt: soon(0), working: true },
      });
    if (path === "/api/responsibilities")
      return Response.json({ responsibilities: data.goals ?? [] });
    if (path === "/api/proactive/settings")
      return Response.json({ settings: data.checkIns ?? [], allowed: true });
    if (path.endsWith("/activity"))
      return Response.json({ activity: activity(data.onDemand) });
    if (path.endsWith("/lifecycle"))
      return Response.json({
        lifecycle: {
          agentId: "scout",
          paused: data.paused ?? false,
          pausedAt: null,
          notify: "all",
        },
      });
    if (path === "/api/bots/attention")
      return Response.json({ bots: [], lastPingId: null, pausedAll: false });
    return Response.json({}, { status: 404 });
  }) as unknown as typeof fetch;
  const router = createRouter({
    routeTree: createRootRoute({
      component: () => <BotRoutinesSection agentId="scout" botName="Scout" />,
    }),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

test("a Bot whose only standing work is a check-in gets the section, with what it reads", async () => {
  const view = drawn({ checkIns: [checkIn("Your Gmail inbox")] });
  expect(await view.findByRole("heading", { name: "Routines" })).toBeTruthy();
  expect(view.getByText("1 scheduled")).toBeTruthy();
  expect(view.getByText("Your Gmail inbox")).toBeTruthy();
  expect(view.getByText(/Reads Gmail/)).toBeTruthy();
  const all = view.getByText("All routines").closest("a");
  expect(all?.getAttribute("href")).toBe("/bots/scout/routines");
  expect(all?.textContent).toContain("1 in all");
});

test("five rows at most, then All routines with the whole count, off ones counted there", async () => {
  const view = drawn({
    routines: [
      ...["A", "B", "C", "D", "E", "F"].map((id, index) =>
        routine(id, { nextRunAt: soon(index + 1) }),
      ),
      routine("Off", { enabled: false }),
    ],
  });
  await view.findByText("A");
  const section = view
    .getByRole("heading", { name: "Routines" })
    .closest("section") as HTMLElement;
  const titles = [...section.querySelectorAll("[data-slot=item-title]")].map(
    (title) => title.firstElementChild?.textContent ?? title.textContent,
  );
  expect(titles).toEqual(["A", "B", "C", "D", "E", "All routines"]);
  expect(within(section).getByText("7 in all")).toBeTruthy();
});

test("a running row carries the pulsing dot", async () => {
  const view = drawn({
    routines: [
      routine("Morning leads", { lastRun: { status: null, at: null } }),
    ],
  });
  const row = (await view.findByText("Morning leads")).closest(
    "[data-slot=item]",
  ) as HTMLElement;
  expect(row.querySelector("[data-running]")).not.toBeNull();
  expect(view.getByText("1 running")).toBeTruthy();
});

test("a Bot with nothing on gets no section", async () => {
  const view = drawn({
    routines: [routine("Off", { enabled: false })],
    checkIns: [checkIn("Quiet", { enabled: false })],
  });
  await settleReactWork();
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(view.queryByRole("heading", { name: "Routines" })).toBeNull();
});

test("while the Bot is paused, its rows read Paused", async () => {
  const view = drawn({
    paused: true,
    routines: [routine("Morning leads")],
    checkIns: [checkIn("Inbox")],
  });
  const row = (await view.findByText("Morning leads")).closest(
    "[data-slot=item]",
  ) as HTMLElement;
  await within(row).findByText(/^Paused/);
  const inbox = view
    .getByText("Inbox")
    .closest("[data-slot=item]") as HTMLElement;
  expect(within(inbox).getByText(/Paused/)).toBeTruthy();
});
