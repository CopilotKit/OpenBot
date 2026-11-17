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
import { routinesPlace } from "@/components/places/routines-place";
import { type AgentProfile, agentKeys } from "@/lib/agents/queries";
import { type ProactiveSetting, proactiveKeys } from "@/lib/proactive";
import {
  type ResponsibilityRecord,
  responsibilityKeys,
} from "@/lib/responsibilities";
import { type RoutineRecord, routineKeys } from "@/lib/routines/queries";
import { settleReactWork } from "./settle-react-work";

/*
 * The Routines place's list: each Bot's routines, goals and check-ins under its name, each row a
 * link to its own page.
 */

const RoutinesPlace = routinesPlace.List;

const originalFetch = globalThis.fetch;
const clients: QueryClient[] = [];

beforeAll(() => {
  GlobalRegistrator.register({
    url: "http://localhost/",
    width: 1280,
    height: 840,
  });
});
afterEach(() => {
  cleanup();
  for (const client of clients) client.clear();
  clients.length = 0;
  globalThis.fetch = originalFetch;
});
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

function bot(id: string, name: string): AgentProfile {
  return { id, name } as unknown as AgentProfile;
}

function routine(overrides: Partial<RoutineRecord> = {}): RoutineRecord {
  return {
    id: "r1",
    botId: "ada",
    schedule: "Weekdays at 09:00",
    timezone: "UTC",
    instruction: "Send yesterday's new leads",
    title: null,
    conversation: { id: "c", name: null, title: "Leads", gone: false },
    enabled: true,
    nextRunAt: "2999-01-01T09:00:00.000Z",
    lastRun: null,
    goalId: null,
    createdAt: "2026-10-09T10:00:00Z",
    ...overrides,
  } as RoutineRecord;
}

function goal(
  overrides: Partial<ResponsibilityRecord> = {},
): ResponsibilityRecord {
  return {
    id: "g1",
    botId: "ada",
    title: "Reconcile receipts",
    status: "active",
    progress: "",
    ...overrides,
  } as ResponsibilityRecord;
}

function checkIn(overrides: Partial<ProactiveSetting> = {}): ProactiveSetting {
  return {
    id: "k1",
    botId: "ada",
    subject: "Unanswered email",
    enabled: true,
    ...overrides,
  } as ProactiveSetting;
}

function renderPlace({
  routines = [],
  goals = [],
  checkIns = [],
  shown = [bot("ada", "Ada")],
  hidden = [],
  goalsFail = false,
}: {
  routines?: RoutineRecord[];
  goals?: ResponsibilityRecord[];
  checkIns?: ProactiveSetting[];
  shown?: AgentProfile[];
  hidden?: AgentProfile[];
  /** The goals read fails instead of answering. */
  goalsFail?: boolean;
}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  clients.push(queryClient);
  queryClient.setQueryData(routineKeys.list(), { routines });
  if (goalsFail) {
    globalThis.fetch = Object.assign(
      async () => Response.json({ error: "down" }, { status: 500 }),
      { preconnect: originalFetch.preconnect },
    );
  } else {
    queryClient.setQueryData(responsibilityKeys.all, goals);
  }
  queryClient.setQueryData(proactiveKeys.settings, {
    settings: checkIns,
    allowed: true,
  });
  queryClient.setQueryData(agentKeys.list(false), shown);
  queryClient.setQueryData(agentKeys.list(true), hidden);
  const router = createRouter({
    routeTree: createRootRoute({
      component: () => <RoutinesPlace scrollRoot={{ current: null }} />,
    }),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

test("a goal's row says Goal and links to its page", async () => {
  const view = renderPlace({ goals: [goal()] });
  const row = (await view.findByText("Reconcile receipts")).closest(
    "a",
  ) as HTMLElement;
  expect(row.getAttribute("href")).toBe("/routines/goals/g1");
  expect(row.textContent).toContain("Goal");
});

test("a routine links to its page", async () => {
  const view = renderPlace({ routines: [routine()] });
  const row = (await view.findByText("Send yesterday's new leads")).closest(
    "a",
  ) as HTMLElement;
  expect(row.getAttribute("href")).toBe("/routines/schedules/r1");
});

test("a check-in links to its page", async () => {
  const view = renderPlace({ checkIns: [checkIn()] });
  const row = (await view.findByText("Unanswered email")).closest(
    "a",
  ) as HTMLElement;
  expect(row.getAttribute("href")).toBe("/routines/check-ins/k1");
});

test("a hidden Bot's routines are under its name", async () => {
  const view = renderPlace({
    routines: [routine({ botId: "shy" })],
    shown: [],
    hidden: [bot("shy", "Shy")],
  });
  const row = await view.findByText("Send yesterday's new leads");
  const heading = view.getByRole("heading", { name: "Shy" });
  expect(heading).toBeTruthy();
  expect(
    heading.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(view.queryByText("A Bot")).toBeNull();
});

test("with no routines the list says so", async () => {
  const view = renderPlace({});
  expect(
    await view.findByText("No routines yet. Start one with New routine."),
  ).toBeTruthy();
});

test("a read that failed says what and what to do, and keeps the rest of the list", async () => {
  const view = renderPlace({ goalsFail: true, routines: [routine()] });
  expect((await view.findByRole("alert")).textContent).toBe(
    "Couldn't load your goals. Try again in a moment.",
  );
  expect(view.getByText("Send yesterday's new leads")).toBeTruthy();
  expect(view.queryByText(/No routines yet/)).toBeNull();
});
