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
import { scheduleWords } from "@/components/routines/routine-dialog";
import { RoutinesList } from "@/components/routines/routines-list";
import type { RoutinesPage } from "@/lib/routines/queries";
import { queryClient } from "@/query-client";
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
  global.fetch = (async (input: RequestInfo | URL) => {
    const path = String(input);
    if (path.startsWith("/api/routines")) return Response.json(PAGE);
    if (path === "/api/responsibilities")
      return Response.json({ responsibilities: [] });
    if (path === "/api/proactive/settings")
      return Response.json({ settings: [], allowed: true });
    return Response.json({});
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

/** A line ending in `text`: on the every-Bot list it opens with the Bot's name. */
const endsWith = (text: string) =>
  new RegExp(`${text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);

/** The row's heading, without the small kind label ("Schedule") beside it. */
function titleOf(element: HTMLElement) {
  return element.closest('[data-slot="item-title"]')?.childNodes[0]
    ?.textContent;
}

test("a named routine is headed by its name, with its schedule under it", async () => {
  const view = draw();

  const named = await view.findByText("Morning briefing");
  expect(titleOf(named)).toBe("Morning briefing");
  // The zone is said where it isn't the reader's own; the details always say it.
  expect(
    view.getByText(
      endsWith(
        `${scheduleWords({ schedule: "Every day at 08:00", timezone: "Europe/Madrid" })} · Acts`,
      ),
    ),
  ).toBeTruthy();
  expect(
    view.getByText("Summarise my unread mail and today's meetings."),
  ).toBeTruthy();
});

test("a routine with no name is headed by its instruction, with its schedule under it", async () => {
  const view = draw();

  const unnamed = await view.findByText("Post the day's open pull requests.");
  expect(titleOf(unnamed)).toBe("Post the day's open pull requests.");
  expect(
    view.getByText(
      endsWith(
        `${scheduleWords({ schedule: "Weekdays at 18:00", timezone: "UTC" })} · Acts`,
      ),
    ),
  ).toBeTruthy();
});

test("a schedule names its time zone only where it isn't the reader's own", () => {
  const madrid = { schedule: "Every day at 08:00", timezone: "Europe/Madrid" };
  expect(scheduleWords(madrid, "Europe/Madrid")).toBe("Every day at 08:00");
  expect(scheduleWords(madrid, "America/New_York")).toBe(
    "Every day at 08:00 · Europe/Madrid",
  );
});
