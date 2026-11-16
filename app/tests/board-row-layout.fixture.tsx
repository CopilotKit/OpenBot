import { QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { createRoot } from "react-dom/client";
import { TaskBoardRow } from "@/components/tasks/task-row";
import type { BotTask } from "@/lib/tasks/queries";
import { queryClient } from "@/query-client";

/**
 * Rows of the Needs you board in the board's own card, at the width of the column it sits in, as a
 * page of its own for board-row-layout.test.tsx to bundle and load in a real browser.
 *
 * Three rows: a task the person stopped, with all three of its buttons (Try again, Mark done, Open),
 * one waiting on the person for an approval, and one ready to read. `?width=<px>` is the column's width.
 */
const width = Number(new URLSearchParams(location.search).get("width") ?? 650);
const now = new Date().toISOString();

const task = (id: string, rest: Partial<BotTask>): BotTask => ({
  id,
  agentId: "assistant",
  channelId: `channel_${id}`,
  threadId: `thread_${id}`,
  title: "Research Pike Place Market's history",
  why: null,
  origin: "delegated",
  suggestionId: null,
  sourceApp: null,
  sourceLink: null,
  originChannelId: "channel_main",
  status: "ready_for_review",
  failure: null,
  failedAt: null,
  next: null,
  resolvedAt: null,
  createdAt: now,
  updatedAt: now,
  ...rest,
});

const stopped = task("stopped", {
  status: "failed",
  failure: "you stopped it",
  failedAt: now,
  stoppedAt: now,
});
const ready = task("ready", {
  title: "Research Seattle Central Library's building history",
  next: "The planned dates for the remaining elevators are projections, not confirmed completions.",
});

// What a waiting task says it waits for, as the server writes it: read whole, never cut short.
const waiting = task("waiting", {
  title: "Ask Pipeline Bot for the pipeline code word",
  status: "needs_input",
  next: "Waiting for your approval: hand this to Pipeline Bot, which acts as Dana and can read the deals pipeline",
});

const router = createRouter({
  routeTree: createRootRoute({
    component: () => (
      <div className="bg-background p-4" style={{ width }}>
        <div className="overflow-hidden rounded-lg border border-border bg-card">
          <div data-row="stopped">
            <TaskBoardRow listed={{ task: stopped, status: "failed" }} />
          </div>
          <div data-row="waiting">
            <TaskBoardRow listed={{ task: waiting, status: "needs_input" }} />
          </div>
          <div data-row="ready">
            <TaskBoardRow
              listed={{ task: ready, status: "ready_for_review" }}
            />
          </div>
        </div>
      </div>
    ),
  }),
  history: createMemoryHistory({ initialEntries: ["/"] }),
});

const root = document.getElementById("root");
if (root)
  createRoot(root).render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
