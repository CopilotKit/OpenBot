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
import { scheduleWords } from "@/components/routines/routine-page";
import { RoutinesList } from "@/components/routines/routines-list";
import type { RoutinesPage } from "@/lib/routines/queries";
import { queryClient } from "@/query-client";
import { answerScheduleLists } from "./schedules-api";
import { settleReactWork } from "./settle-react-work";

/**
 * A routine the person named heads its row with their name, and one they didn't is headed by what it
 * does, its instruction. Its schedule is under it either way: what it is, then when it starts.
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
      botId: "general-assistant",
      schedule: "Every day at 08:00",
      timezone: "Europe/Madrid",
      instruction: "Summarise my unread mail and today's meetings.",
      title: "Morning briefing",
      conversation: {
        id: "conversation-briefing",
        name: "General Assistant",
        title: "Briefings",
        gone: false,
      },
      enabled: true,
      nextRunAt: "2026-11-08T07:00:00.000Z",
      lastRun: null,
      goalId: null,
      createdAt: "2026-11-01T09:00:00.000Z",
    },
    {
      id: "routine-unnamed",
      botId: "general-assistant",
      schedule: "Weekdays at 18:00",
      timezone: "UTC",
      instruction: "Post the day's open pull requests.",
      title: null,
      conversation: {
        id: "conversation-prs",
        name: "General Assistant",
        title: "Pull requests",
        gone: false,
      },
      enabled: true,
      nextRunAt: "2026-11-09T18:00:00.000Z",
      lastRun: null,
      goalId: null,
      createdAt: "2026-11-01T09:00:00.000Z",
    },
  ],
};

function draw() {
  global.fetch = (async (input: RequestInfo | URL) => {
    return answerScheduleLists(input, undefined, PAGE) ?? Response.json({});
  }) as unknown as typeof fetch;
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

/** The row a piece of text is on. */
function rowOf(element: HTMLElement) {
  return element.closest('[data-slot="item"]') as HTMLElement;
}

/** The row's heading: its when. */
function titleOf(row: HTMLElement) {
  return row.querySelector('[data-slot="item-title"]')?.textContent;
}

test("a named routine is headed by its schedule, with its name and what it does under it", async () => {
  const view = draw();

  const row = rowOf(await view.findByText("Morning briefing"));
  // The zone is said where it isn't the reader's own.
  expect(titleOf(row)).toBe(
    scheduleWords({
      schedule: "Every day at 08:00",
      timezone: "Europe/Madrid",
    }),
  );
  expect(row.textContent).toContain(
    "Summarise my unread mail and today's meetings.",
  );
  expect(row.textContent).toContain("Posts in Briefings");
});

test("a routine with no name is headed by its schedule, with its instruction under it", async () => {
  const view = draw();

  const row = rowOf(
    await view.findByText("Post the day's open pull requests."),
  );
  expect(titleOf(row)).toBe(
    scheduleWords({ schedule: "Weekdays at 18:00", timezone: "UTC" }),
  );
});

test("a schedule names its time zone only where it isn't the reader's own", () => {
  const madrid = { schedule: "Every day at 08:00", timezone: "Europe/Madrid" };
  expect(scheduleWords(madrid, "Europe/Madrid")).toBe("Every day at 08:00");
  expect(scheduleWords(madrid, "America/New_York")).toBe(
    "Every day at 08:00 · Europe/Madrid",
  );
});
