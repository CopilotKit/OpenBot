import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render } from "@testing-library/react";
import { BotGroupSection } from "@/components/routines/bot-group";
import { viewerTimeZone } from "@/components/routines/routine-page";
import type { CheckIn } from "@/lib/api/generated/model/checkIn";
import type { BotGroup } from "@/lib/routines/by-bot";
import type { MergedRoutine } from "@/lib/routines/merged";
import type { RoutineRecord } from "@/lib/routines/queries";
import { queryClient } from "@/query-client";
import { settleReactWork } from "./settle-react-work";

/**
 * A Bot's group on the Routines page: its orb, name and count, then one line per row, the row's name
 * and the one fact about it.
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

const routine = (overrides: Partial<RoutineRecord> = {}): RoutineRecord => ({
  id: "r1",
  botId: "b1",
  schedule: "Every weekday at 9:00",
  cron: "0 9 * * 1-5",
  // The reader's own zone, so the schedule is read as the server gave it.
  timezone: viewerTimeZone(),
  instruction: "Post the standup summary.",
  title: "Standup summary",
  conversation: { id: "c1", name: null, title: "Standup", gone: false },
  enabled: true,
  nextRunAt: "2999-01-01T09:00:00.000Z",
  lastRun: null,
  goalId: null,
  createdAt: "2026-10-09T10:00:00Z",
  ...overrides,
});

const routineRow = (overrides: Partial<RoutineRecord> = {}): MergedRoutine => ({
  kind: "routine",
  id: overrides.id ?? "r1",
  agentId: "b1",
  routine: routine(overrides),
});

const checkInRow = (overrides: Partial<CheckIn> = {}): MergedRoutine => ({
  kind: "check-in",
  id: "k1",
  agentId: "b1",
  checkIn: {
    id: "k1",
    botId: "b1",
    conversationId: "c1",
    focus: "",
    subject: "",
    sourceLink: null,
    enabled: true,
    intervalMinutes: 1440,
    nextRunAt: "2999-01-01T09:00:00.000Z",
    lastRunAt: null,
    lastStatus: "idle",
    lastError: null,
    lastRun: null,
    createdAt: "2026-10-09T10:00:00Z",
    updatedAt: "2026-10-09T10:00:00Z",
    ...overrides,
  },
});

function draw(rows: MergedRoutine[], overrides: Partial<BotGroup> = {}) {
  const group: BotGroup = {
    botId: "b1",
    name: "Atlas",
    seed: "atlas",
    hidden: false,
    known: true,
    rows,
    ...overrides,
  };
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: createRootRoute({
      component: () => <BotGroupSection group={group} />,
    }),
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

test("a routine's row links to its page, and reads its name and its schedule", async () => {
  const view = draw([routineRow()]);

  const name = await view.findByText("Standup summary");
  expect(name.closest("a")?.getAttribute("href")).toBe(
    "/routines/schedules/r1",
  );
  expect(view.getByText("Every weekday at 9:00")).toBeTruthy();
  expect(view.getByText("Atlas").closest("a")?.getAttribute("href")).toBe(
    "/bots/b1/routines",
  );
});

test("a Bot no list knows is drawn as a name, with no link", async () => {
  const view = draw([routineRow()], { known: false, name: "A Bot" });

  const name = await view.findByText("A Bot");
  expect(name.closest("a")).toBeNull();
});

test("a Bot that is really named A Bot keeps its link", async () => {
  const view = draw([routineRow()], { known: true, name: "A Bot" });

  const name = await view.findByText("A Bot");
  expect(name.closest("a")?.getAttribute("href")).toBe("/bots/b1/routines");
});

test("a failed last run reads as a warning", async () => {
  const view = draw([
    routineRow({
      lastRun: { at: new Date().toISOString(), status: "failed" },
    }),
  ]);

  const fact = await view.findByText(/^Failed /);
  expect(fact.className).toContain("text-warning");
});

test("a paused routine reads Paused, at 60% opacity", async () => {
  const view = draw([routineRow({ enabled: false })]);

  const fact = await view.findByText("Paused");
  expect(fact.closest("a")?.className).toContain("opacity-60");
});

test("a routine that is off shows the pause icon even when its last run failed", async () => {
  const view = draw([
    routineRow({
      enabled: false,
      lastRun: { at: new Date().toISOString(), status: "failed" },
    }),
  ]);

  const fact = await view.findByText(/^Failed /);
  const row = fact.closest("a");
  expect(row?.querySelector("svg")?.getAttribute("class")).toContain(
    "tabler-icon-player-pause",
  );
  expect(row?.className).not.toContain("opacity-60");
});

test("a check-in with no subject reads Everything it reads", async () => {
  const view = draw([checkInRow()]);

  const name = await view.findByText("Everything it reads");
  expect(name.closest("a")?.getAttribute("href")).toBe(
    "/routines/check-ins/k1",
  );
});
