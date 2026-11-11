import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { GoalRoutePage } from "@/components/responsibilities/goal-page";
import type { ResponsibilityRecord } from "@/lib/responsibilities";
import { queryClient } from "@/query-client";
import { settleReactWork } from "./settle-react-work";

/**
 * A goal's page, reached by its address: found in the goals list, gone, or unreadable for now.
 * It was a dialog over the Routines list, which clipped its sections on a short screen.
 */

const goal: ResponsibilityRecord = {
  id: "goal-1",
  agentId: "bot-1",
  channelId: "c1",
  threadId: "t1",
  title: "Watch the queue",
  instruction: "Tell me when the queue backs up.",
  successCriteria: "",
  status: "active",
  progress: "",
  lastResult: null,
  subscriptions: [],
  recurring: false,
  endsWhenMet: false,
  updatedAt: "2026-11-10T10:00:00Z",
};

/** How the goals read answers right now. */
let goals: "ok" | "fail" = "ok";
const originalFetch = global.fetch;

beforeAll(() => GlobalRegistrator.register({ url: "http://localhost/" }));
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});
beforeEach(() => {
  queryClient.clear();
  goals = "ok";
  global.fetch = (async (input: Parameters<typeof fetch>[0]) => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname === "/api/responsibilities")
      return goals === "fail"
        ? Response.json({ error: "Server error" }, { status: 500 })
        : Response.json({ responsibilities: [goal] });
    if (url.pathname === "/api/routines")
      return Response.json({ routines: [], sweep: null });
    return Response.json({ triggers: [], runs: [] });
  }) as typeof fetch;
});
afterEach(() => {
  cleanup();
  queryClient.clear();
  global.fetch = originalFetch;
});

async function visit(goalId: string, agentId?: string) {
  const root = createRootRoute();
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: root.addChildren([
      createRoute({
        getParentRoute: () => root,
        path: "/",
        component: () => <GoalRoutePage agentId={agentId} goalId={goalId} />,
      }),
    ]),
  });
  await router.load();
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

test("the goal is found in the goals list and drawn as its page, back to the list it came from", async () => {
  const view = await visit("goal-1", "bot-1");
  await view.findByRole("heading", { level: 1, name: "Watch the queue" });
  // The bar's back link: drawn as a button, an anchor underneath.
  const back = view.getByText("Routines").closest("a");
  expect(back?.getAttribute("href")).toBe("/bots/bot-1/routines");
});

test("an address for a goal that isn't there says so, not an empty page", async () => {
  const view = await visit("gone");
  await view.findByText("This goal isn't here");
  expect(view.getByText("Routines").closest("a")?.getAttribute("href")).toBe(
    "/routines",
  );
});

test("a failed read says so and Retry loads the goal", async () => {
  goals = "fail";
  const view = await visit("goal-1");
  const retry = await view.findByRole(
    "button",
    { name: "Retry" },
    { timeout: 3000 },
  );
  expect(view.getByText("Couldn't load this goal. Try again.")).toBeTruthy();
  goals = "ok";
  fireEvent.click(retry);
  expect(
    (await view.findByRole("heading", { level: 1, name: "Watch the queue" }))
      .textContent,
  ).toBe("Watch the queue");
});
