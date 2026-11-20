import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { GoalRoutePage } from "@/components/responsibilities/goal-page";
import type { ResponsibilityRecord } from "@/lib/responsibilities";
import { queryClient } from "@/query-client";
import { answerBotsList } from "./bots-api";
import { GOALS_PATH, pathOf, ROUTINES_PATH } from "./schedules-api";
import { settleReactWork } from "./settle-react-work";

/*
 * Delete on a goal's page stops everything that reads that goal. Its page stays up for a moment
 * after the delete, while the list of goals is read again, and in that moment it used to ask once
 * more for the goal's triggers or runs, which could only answer that the goal is not found.
 */

beforeAll(() => GlobalRegistrator.register({ url: "http://localhost/" }));
afterEach(() => {
  cleanup();
  queryClient.clear();
});
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
});

const GOAL: ResponsibilityRecord = {
  id: "goal-1",
  botId: "lead-desk",
  conversationId: "conversation-1",
  threadId: "thread-1",
  title: "Watch the queue",
  instruction: "Tell me when the queue backs up.",
  successCriteria: "",
  status: "active",
  progress: "",
  lastResult: null,
  subscriptions: [],
  recurring: false,
  endsWhenMet: false,
  createdAt: "2026-11-10T10:00:00Z",
  updatedAt: "2026-11-10T10:00:00Z",
  completedAt: null,
};

/**
 * The server: the goal until it is deleted, and a 404 for its triggers and runs after, as the real
 * one. It counts how often anything about the deleted goal was asked for.
 */
function serving() {
  let deleted = false;
  const asked = { aboutTheGoalAfterDelete: [] as string[] };
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = pathOf(input);
    const method = init?.method ?? "GET";
    if (path === `${GOALS_PATH}/${GOAL.id}` && method === "DELETE") {
      deleted = true;
      return new Response(null, { status: 204 });
    }
    if (path.startsWith(`${GOALS_PATH}/${GOAL.id}/`)) {
      if (deleted) {
        asked.aboutTheGoalAfterDelete.push(path);
        return Response.json({ detail: "Goal not found." }, { status: 404 });
      }
      return Response.json({ triggers: [], runs: [], nextCursor: null });
    }
    if (path === GOALS_PATH) {
      // A real list takes a moment to come back, and the page is still up until it does.
      if (deleted) await new Promise((resolve) => setTimeout(resolve, 150));
      return Response.json({ goals: deleted ? [] : [GOAL], nextCursor: null });
    }
    if (path === ROUTINES_PATH)
      return Response.json({ routines: [], nextCursor: null });
    const bots = answerBotsList(path, init, {
      visible: [
        { id: "lead-desk", name: "Lead Desk", avatarSeed: "lead-desk" },
      ],
      hidden: [],
    });
    if (bots) return bots;
    return Response.json({});
  }) as unknown as typeof fetch;
  return asked;
}

function drawAt(path: string) {
  const root = createRootRoute();
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: [path] }),
    routeTree: root.addChildren([
      createRoute({
        getParentRoute: () => root,
        path: "/routines/goals/$goalId",
        component: () => <GoalRoutePage goalId={GOAL.id} />,
      }),
      createRoute({
        getParentRoute: () => root,
        path: "/routines",
        component: () => <h1>Routines</h1>,
      }),
    ]),
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
  return { view, router };
}

test("a deleted goal's triggers and runs are never asked for again", async () => {
  const asked = serving();
  const { view, router } = drawAt(`/routines/goals/${GOAL.id}`);
  const user = userEvent.setup({ document });
  await user.click(
    await view.findByRole("button", {
      name: "Delete the goal Watch the queue",
    }),
  );
  const dialog = await view.findByRole("dialog");
  await user.click(within(dialog).getByRole("button", { name: "Delete" }));
  await waitFor(
    () => expect(router.state.location.pathname).toBe("/routines"),
    { timeout: 3_000 },
  );
  // Long enough for a read started by the delete to have gone out.
  await new Promise((resolve) => setTimeout(resolve, 200));

  expect(asked.aboutTheGoalAfterDelete).toEqual([]);
});
