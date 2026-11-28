import { QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { createRoot } from "react-dom/client";
import { RoutineRoutePage } from "@/components/routines/routine-page";
import { setCurrentOrganization } from "@/lib/organizations/current";
import { queryClient } from "@/query-client";
import { answerBotsList } from "./bots-api";
import { ROUTINES_PATH, routineRunsPath } from "./schedules-api";

/**
 * A routine's page, as a page of its own for routine-run-now-layout.test.tsx to bundle and load in a
 * browser. The server's answers come from a fetch here, as the API gives them: one routine, and
 * runRoutine answering 202 with the run it started, which then shows in the routine's runs.
 */
setCurrentOrganization("default");
queryClient.setDefaultOptions({ queries: { retry: false } });

const ROUTINE = {
  id: "routine-1",
  botId: "lead-desk",
  schedule: "Weekdays at 09:00",
  cron: "0 9 * * 1-5",
  timezone: "Europe/Madrid",
  instruction: "Send me a summary of yesterday's new leads",
  title: "Morning leads",
  conversation: {
    id: "conversation-1",
    name: "Lead Desk",
    title: "Leads",
    gone: false,
  },
  enabled: true,
  nextRunAt: "2099-01-01T08:00:00.000Z",
  lastRun: null,
  goalId: null,
  createdAt: "2026-11-01T09:00:00.000Z",
};
const RUN_ID = "0f1e2d3c-4b5a-4968-8776-5a4b3c2d1e0f";
const runs: unknown[] = [];

window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const path = new URL(String(input), location.origin).pathname;
  const method = (init?.method ?? "GET").toUpperCase();
  if (path === `${ROUTINES_PATH}/${ROUTINE.id}/run` && method === "POST") {
    runs.unshift({
      id: RUN_ID,
      status: "running",
      startedAt: new Date().toISOString(),
      finishedAt: null,
      error: null,
      source: "run_now",
    });
    return Response.json({ accepted: true, runId: RUN_ID }, { status: 202 });
  }
  if (path === routineRunsPath(ROUTINE.id))
    return Response.json({ runs, nextCursor: null });
  if (path === ROUTINES_PATH)
    return Response.json({ routines: [ROUTINE], nextCursor: null });
  const bots = answerBotsList(input, init, {
    visible: [{ id: "lead-desk", name: "Lead Desk", avatarSeed: "lead-desk" }],
    hidden: [],
  });
  if (bots) return bots;
  return Response.json({ detail: "not served" }, { status: 404 });
}) as typeof fetch;

const root = createRootRoute();
const router = createRouter({
  history: createMemoryHistory({
    initialEntries: [`/routines/schedules/${ROUTINE.id}`],
  }),
  routeTree: root.addChildren([
    createRoute({
      getParentRoute: () => root,
      path: "/routines/schedules/$routineId",
      component: () => (
        <div className="flex h-svh flex-col bg-background text-foreground">
          <RoutineRoutePage routineId={ROUTINE.id} />
        </div>
      ),
    }),
    createRoute({
      getParentRoute: () => root,
      path: "/channel/$channelId",
      component: () => <p>A conversation</p>,
    }),
  ]),
});

const mount = document.getElementById("root");
if (mount)
  createRoot(mount).render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
