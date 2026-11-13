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
import { RoutineRoutePage } from "@/components/routines/routine-page";
import type { RoutineRecord } from "@/lib/routines/queries";
import { queryClient } from "@/query-client";
import { answerBotsList } from "./bots-api";
import { settleReactWork } from "./settle-react-work";

/*
 * Delete on a routine's page goes back to Routines. It used to leave the person on "This routine
 * isn't here": the list the page reads came back without the routine and took the page down while
 * the delete was still waiting on its other reads (the routine's runs, a 404 now), and the
 * navigation was a callback on the page that had gone.
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

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
});

const ROUTINE: RoutineRecord = {
  id: "routine-1",
  agentId: "lead-desk",
  schedule: "Weekdays at 09:00",
  timezone: "Europe/Madrid",
  instruction: "Send me a summary of yesterday's new leads",
  title: "Morning leads",
  channel: {
    id: "conversation-1",
    name: "Lead Desk",
    title: "Leads",
    gone: false,
  },
  enabled: true,
  nextRunAt: "2099-01-01T08:00:00.000Z",
  lastRun: null,
};

/** The server: the routine until it is deleted, and a 404 for its runs after, as the real one. */
function serving() {
  let deleted = false;
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const method = init?.method ?? "GET";
    if (path === `/api/routines/${ROUTINE.id}` && method === "DELETE") {
      deleted = true;
      return Response.json({ ok: true });
    }
    if (path === `/api/routines/${ROUTINE.id}/runs`)
      return deleted
        ? Response.json({ error: "Routine not found." }, { status: 404 })
        : Response.json({ runs: [] });
    if (path === "/api/routines")
      return Response.json({
        routines: deleted ? [] : [ROUTINE],
        sweep: { lastSweptAt: new Date().toISOString(), working: true },
      });
    const bots = answerBotsList(path, init, {
      visible: [
        { id: "lead-desk", name: "Lead Desk", avatarSeed: "lead-desk" },
      ],
      hidden: [],
    });
    if (bots) return bots;
    return Response.json({});
  }) as unknown as typeof fetch;
}

function drawAt(path: string) {
  const root = createRootRoute();
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: [path] }),
    routeTree: root.addChildren([
      createRoute({
        getParentRoute: () => root,
        path: "/routines/schedules/$routineId",
        component: () => <RoutineRoutePage routineId={ROUTINE.id} />,
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

test("Delete on a routine's page goes back to Routines", async () => {
  serving();
  const { view, router } = drawAt(`/routines/schedules/${ROUTINE.id}`);
  const user = userEvent.setup({ document });
  await user.click(
    await view.findByRole("button", {
      name: "Delete the routine scheduled Weekdays at 09:00",
    }),
  );
  // Asked about by its name, as its heading says, never by its schedule.
  const dialog = await view.findByRole("dialog", {
    name: "Delete “Morning leads”?",
  });
  await user.click(within(dialog).getByRole("button", { name: "Delete" }));

  await waitFor(
    () => expect(router.state.location.pathname).toBe("/routines"),
    { timeout: 3_000 },
  );
  expect(view.getByRole("heading", { name: "Routines" })).toBeTruthy();
  expect(view.queryByText("This routine isn't here")).toBeNull();
});
