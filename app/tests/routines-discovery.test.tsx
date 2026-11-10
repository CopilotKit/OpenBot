import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, within } from "@testing-library/react";
import type * as React from "react";
import { RoutineComposerButton } from "@/components/routines/new-routine-button";
import { RoutinesConnectionPage } from "@/components/routines/routines-connection-page";
import { RoutinesList } from "@/components/routines/routines-list";
import { cronFrom, scheduleSentence } from "@/lib/routines/form";
import type { RoutineRecord, RoutinesPage } from "@/lib/routines/queries";
import { queryClient } from "@/query-client";
import { settleReactWork } from "./settle-react-work";

/**
 * Somebody who wants a Bot to do something every morning, and does not know Routines exist, has to
 * be led to the one page where routines are made: from Connections, from an empty list, and from the
 * clock beside a conversation's message box. The sidebar entry is in `app-navigation.test.tsx`.
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

function routine(overrides: Partial<RoutineRecord>): RoutineRecord {
  return {
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
    ...overrides,
  };
}

/** `/api/routines` and `/api/agents` in the shapes the server sends them. */
function draw(element: React.ReactNode, page: RoutinesPage) {
  global.fetch = (async (input: RequestInfo | URL) => {
    const path = String(input);
    if (path.startsWith("/api/routines")) return Response.json(page);
    if (path.startsWith("/api/agents"))
      return Response.json({
        agents: path.includes("hidden=true")
          ? []
          : [{ id: "lead-desk", name: "Lead Desk", avatarSeed: "lead-desk" }],
      });
    return Response.json({});
  }) as unknown as typeof fetch;
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: createRootRoute({ component: () => element }),
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

const SWEEP = { lastSweptAt: new Date().toISOString(), working: true };

test("Connections > Routines says what Routines is and leads to the Routines page", async () => {
  const view = draw(<RoutinesConnectionPage />, {
    routines: [routine({}), routine({ id: "routine-2", enabled: false })],
    sweep: SWEEP,
  });
  expect(
    await view.findByText(
      "Routines are work your Bots do on a schedule. Every Bot can set one up for you.",
    ),
  ).toBeTruthy();
  const row = await view.findByRole("link", { name: /Your routines/ });
  expect(row.getAttribute("href")).toBe("/routines");
  expect(await within(row).findByText("2 routines, 1 on.")).toBeTruthy();
  expect(
    view.getByRole("button", { name: "New routine" }).getAttribute("href"),
  ).toBe("/routines/new");
  // No tools listing: nothing here is a tool to grant.
  expect(view.queryByText(/create_routine/)).toBeNull();
});

test("an empty Routines page offers New routine, and a Bot's own page starts it for that Bot", async () => {
  const empty = { routines: [], sweep: SWEEP };
  const page = draw(<RoutinesList />, empty);
  expect(
    (await page.findByRole("button", { name: "New routine" })).getAttribute(
      "href",
    ),
  ).toBe("/routines/new");
  cleanup();
  queryClient.clear();

  const botPage = draw(<RoutinesList agentId="lead-desk" />, empty);
  expect(await botPage.findByText("No routines for this Bot yet")).toBeTruthy();
  expect(
    (await botPage.findByRole("button", { name: "New routine" })).getAttribute(
      "href",
    ),
  ).toBe("/routines/new?agentId=lead-desk");
});

test("the Routines page says which Bot each routine belongs to", async () => {
  const view = draw(<RoutinesList />, {
    routines: [routine({})],
    sweep: SWEEP,
  });
  const bot = await view.findByRole("link", { name: /Lead Desk/ });
  expect(bot.getAttribute("href")).toBe("/bots/lead-desk/routines");
});

test("the clock beside the message box opens New routine for this Bot, posting here", async () => {
  const view = draw(
    <RoutineComposerButton agentId="lead-desk" channelId="conversation-1" />,
    { routines: [], sweep: SWEEP },
  );
  const clock = await view.findByRole("button", { name: "Set up a routine" });
  expect(clock.getAttribute("href")).toBe(
    "/routines/new?agentId=lead-desk&channelId=conversation-1",
  );
});

test("the schedule picker writes the cron it reads back in words", () => {
  const at = { time: "09:00", weekday: "1", monthDay: "1" };
  const cases = [
    [{ ...at, repeat: "weekdays" }, "0 9 * * 1-5", "Every weekday at 9:00 AM"],
    [
      { ...at, repeat: "daily", time: "18:30" },
      "30 18 * * *",
      "Every day at 6:30 PM",
    ],
    [
      { ...at, repeat: "weekly", weekday: "5", time: "00:15" },
      "15 0 * * 5",
      "Every Friday at 12:15 AM",
    ],
    [
      { ...at, repeat: "monthly", monthDay: "22", time: "12:00" },
      "0 12 22 * *",
      "On the 22nd of every month at 12:00 PM",
    ],
    [{ ...at, repeat: "hourly" }, "0 * * * *", "Every hour, on the hour"],
  ] as const;
  for (const [schedule, cron, words] of cases) {
    expect(cronFrom(schedule)).toBe(cron);
    expect(scheduleSentence(schedule)).toBe(words);
  }
});
