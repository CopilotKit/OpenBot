import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render } from "@testing-library/react";
import { BotRoutinesSummary } from "@/components/bot-profile/routines-summary";
import { viewerTimeZone } from "@/components/routines/routine-page";
import type { RoutineRecord } from "@/lib/routines/queries";
import { answerScheduleLists, pathOf, ROUTINES_PATH } from "./schedules-api";
import { settleReactWork } from "./settle-react-work";

/**
 * A Bot's routines on its own page, under For you: what is running and what is lined up, in the
 * Routines page's words, with See all to the Bot's Routines.
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

const routine = (overrides: Partial<RoutineRecord> = {}): RoutineRecord => ({
  id: "r1",
  botId: "atlas",
  schedule: "Every weekday at 9:00",
  cron: "0 9 * * 1-5",
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

function draw(routines: unknown[], { fail = false } = {}) {
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (fail && pathOf(input) === ROUTINES_PATH)
      return new Response(null, { status: 500 });
    return answerScheduleLists(input, init, { routines }) ?? Response.json({});
  }) as unknown as typeof fetch;
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: createRootRoute({
      component: () => <BotRoutinesSummary agentId="atlas" />,
    }),
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

const rowNames = (view: ReturnType<typeof draw>) =>
  [...view.container.querySelectorAll("a[href^='/routines/']")].map(
    (row) => row.querySelector(".truncate")?.textContent,
  );

test("running first, then what starts soonest, with See all to the Bot's Routines", async () => {
  const view = draw([
    routine({ id: "late", title: "Late", nextRunAt: "2999-01-03T09:00:00Z" }),
    routine({
      id: "running",
      title: "Running",
      // A run still open: started, not finished.
      lastRun: { status: null, at: null },
    }),
    routine({ id: "soon", title: "Soon", nextRunAt: "2999-01-02T09:00:00Z" }),
    routine({ id: "paused", title: "Paused", enabled: false }),
    routine({ id: "other", title: "Someone else's", botId: "scout" }),
  ]);
  await view.findByRole("heading", { name: "Routines" });
  expect(rowNames(view)).toEqual(["Running", "Soon", "Late"]);
  expect(view.getByText("Running now")).toBeTruthy();
  const seeAll = view.getByRole("button", { name: "See all" });
  expect(seeAll.getAttribute("href")).toBe("/bots/atlas/routines");
});

test("at most five, the rest behind See all", async () => {
  const view = draw(
    Array.from({ length: 7 }, (_, index) =>
      routine({
        id: `r${index}`,
        title: `Routine ${index}`,
        nextRunAt: `2999-01-0${index + 1}T09:00:00Z`,
      }),
    ),
  );
  await view.findByRole("heading", { name: "Routines" });
  expect(rowNames(view)).toEqual([
    "Routine 0",
    "Routine 1",
    "Routine 2",
    "Routine 3",
    "Routine 4",
  ]);
});

test("only paused routines: says nothing is running or scheduled, and still has See all", async () => {
  const view = draw([routine({ enabled: false })]);
  expect(await view.findByText("Nothing running or scheduled.")).toBeTruthy();
  expect(view.getByRole("button", { name: "See all" })).toBeTruthy();
  expect(rowNames(view)).toEqual([]);
});

test("a Bot with no routines has no Routines section", async () => {
  const view = draw([routine({ botId: "scout" })]);
  await settleReactWork();
  expect(view.queryByRole("heading", { name: "Routines" })).toBeNull();
});

test("a read that fails is said, and See all still goes to the Bot's Routines", async () => {
  const view = draw([], { fail: true });
  expect(await view.findByRole("alert")).toBeTruthy();
  expect(view.getByRole("button", { name: "See all" })).toBeTruthy();
});
