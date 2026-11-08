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
import { RoutinesList } from "@/components/routines/routines-list";
import type { RoutinesPage } from "@/lib/routines/queries";
import { queryClient } from "@/query-client";
import { settleReactWork } from "./settle-react-work";

/**
 * A routine the person named heads its row with their name, and one they didn't keeps its schedule.
 *
 * Found on Windows: the Bot was asked for "a daily routine called Morning briefing" and said its tool
 * couldn't take a title. The tool takes one now, and this is where the person reads it.
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

const PAGE: RoutinesPage = {
  routines: [
    {
      id: "routine-named",
      agentId: "general-assistant",
      schedule: "Every day at 08:00",
      timezone: "Europe/Madrid",
      instruction: "Summarise my unread mail and today's meetings.",
      title: "Morning briefing",
      channel: {
        id: "conversation-briefing",
        name: "General Assistant",
        title: "Briefings",
        gone: false,
      },
      enabled: true,
      nextRunAt: "2026-11-08T07:00:00.000Z",
      lastRun: null,
    },
    {
      id: "routine-unnamed",
      agentId: "general-assistant",
      schedule: "Weekdays at 18:00",
      timezone: "UTC",
      instruction: "Post the day's open pull requests.",
      title: null,
      channel: {
        id: "conversation-prs",
        name: "General Assistant",
        title: "Pull requests",
        gone: false,
      },
      enabled: true,
      nextRunAt: "2026-11-09T18:00:00.000Z",
      lastRun: null,
    },
  ],
  sweep: { lastSweptAt: "2026-11-07T07:30:00.000Z", working: true },
};

function draw() {
  global.fetch = (async (input: RequestInfo | URL) =>
    String(input).startsWith("/api/routines")
      ? Response.json(PAGE)
      : Response.json({})) as unknown as typeof fetch;
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: createRootRoute({ component: () => <RoutinesList /> }),
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

function titleOf(element: HTMLElement) {
  return element.closest('[data-slot="item-title"]')?.textContent;
}

test("a named routine is headed by its name, with its schedule under it", async () => {
  const view = draw();

  const named = await view.findByText("Morning briefing");
  expect(titleOf(named)).toBe("Morning briefing");
  expect(view.getByText("Every day at 08:00 · Europe/Madrid")).toBeTruthy();
  expect(
    view.getByText("Summarise my unread mail and today's meetings."),
  ).toBeTruthy();
});

test("a routine with no name is still headed by its schedule", async () => {
  const view = draw();

  const unnamed = await view.findByText("Weekdays at 18:00");
  expect(titleOf(unnamed)).toBe("Weekdays at 18:00UTC");
  expect(view.getByText("Post the day's open pull requests.")).toBeTruthy();
});
