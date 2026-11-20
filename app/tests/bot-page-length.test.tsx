import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import {
  activitySummary,
  BotActivityGlance,
  BotActivityRow,
  BotActivitySections,
} from "@/components/bot-profile/activity";
import { SuggestionsInbox } from "@/components/suggestions/proactive-panel";
import type { ActivityItem, BotActivity } from "@/lib/bot-lifecycle/queries";
import { activityResponse, botOperationPath } from "./bots-api";
import { taskOf } from "./conversations-api";
import {
  CHECK_IN_ITEMS_PATH,
  ORGANIZATION_PATH,
  pathOf,
} from "./schedules-api";
import { settleReactWork } from "./settle-react-work";

/**
 * A Bot's page stays short enough to reach its settings: what it is running and has scheduled shows
 * at a glance with the full lists on a page of their own, and its suggestions show the newest few
 * with the rest folded away.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
});

const items = (count: number, name = "Item", needsYou = false) =>
  Array.from(
    { length: count },
    (_, index) =>
      ({
        id: `${name}-${index}`,
        kind: "routine",
        title: `${name} ${index + 1}`,
        detail: null,
        status: "running",
        at: "2026-10-09T10:00:00Z",
        channelId: null,
        needsYou,
        stoppable: false,
        cancellable: false,
      }) as ActivityItem,
  );
const activity = (inProgress: number, scheduled: number, completed: number) =>
  ({
    inProgress: items(inProgress),
    scheduled: items(scheduled),
    completed: items(completed),
  }) as BotActivity;

test("the activity row counts what is running and what is lined up", () => {
  expect(activitySummary(activity(2, 3, 9))).toBe(
    "2 in progress · 3 scheduled",
  );
  expect(activitySummary(activity(0, 1, 0))).toBe("1 scheduled");
  expect(activitySummary(activity(0, 0, 4))).toBe(
    "Nothing running or scheduled",
  );
  expect(activitySummary(activity(0, 0, 0))).toBe(
    "No tasks, routines or goals yet",
  );
});

/*
 * FOUND ON WINDOWS: a goal that only runs when asked sat under Scheduled, and a Bot with one routine
 * and that goal read "2 scheduled".
 */
test("a goal that runs only when asked is counted as on demand, never as scheduled", async () => {
  const [routine] = items(1, "Check releases");
  const goal = {
    ...(routine as ActivityItem),
    id: "responsibility:watch",
    kind: "responsibility",
    title: "Watch OpenBot releases",
    detail: "Runs when asked",
    status: "active",
  } as ActivityItem;
  const data = {
    inProgress: [],
    scheduled: [{ ...(routine as ActivityItem), status: "scheduled" }],
    onDemand: [goal],
    completed: [],
  };
  expect(activitySummary(data)).toBe("1 scheduled · 1 on demand");
  expect(activitySummary({ ...data, scheduled: [] })).toBe("1 on demand");

  const page = glance(data);
  expect(await page.findByText("1 scheduled · 1 on demand")).toBeTruthy();
  expect(page.getByText("Watch OpenBot releases")).toBeTruthy();
  cleanup();

  // The Activity page lists both under Recurring, which ends on a row to the Bot's Routines.
  const sections = glance(data, BotActivitySections);
  const routines = (await sections.findByText("Routines")).closest("a");
  expect(routines?.getAttribute("href")).toBe("/bots/scout/routines");
  expect(routines?.textContent).toContain("1 scheduled · 1 on demand");
  expect(sections.queryByRole("heading", { name: "On demand" })).toBeNull();
  const recurring = sections
    .getByRole("heading", { name: "Recurring" })
    .closest("section") as HTMLElement;
  expect(recurring.textContent).toContain("Watch OpenBot releases");
  expect(recurring.textContent).toContain("Check releases 1");
});

/*
 * The Bot's own follow-ups, a queued run of a goal and a delegated task waiting its turn are lined
 * up too, and the Routines page does not list them. They stay under Scheduled, a follow-up with its
 * Cancel. The routine and the goal are under Recurring, and the row to Routines counts only them.
 */
test("Scheduled keeps the follow-ups and queued runs Routines doesn't list, with their Cancel", async () => {
  const [routine] = items(1, "Check releases");
  const base = routine as ActivityItem;
  const followUp: ActivityItem = {
    ...base,
    id: "wake-up:42",
    kind: "follow_up",
    title: "Chase the invoice reply",
    status: "scheduled",
    cancellable: true,
  };
  const queuedRun: ActivityItem = {
    ...base,
    id: "responsibility-run:7",
    kind: "responsibility",
    title: "Run of Watch OpenBot releases",
    status: "queued",
  };
  const goal: ActivityItem = {
    ...base,
    id: "responsibility:watch",
    kind: "responsibility",
    title: "Watch OpenBot releases",
    status: "active",
  };
  const data: BotActivity = {
    inProgress: [],
    scheduled: [
      { ...base, id: "routine:r1", status: "scheduled" },
      goal,
      followUp,
      queuedRun,
    ],
    onDemand: [],
    completed: [],
  };
  const cancelled: string[] = [];
  const view = glance(data, BotActivitySections);
  const fetchActivity = global.fetch;
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    // The API's cancelFollowUp: the follow-up is named in the address, and nothing is sent.
    const followUp = new RegExp(
      `^${ORGANIZATION_PATH}/bots/[^/]+/follow-ups/([^/]+)/cancel$`,
    ).exec(pathOf(input));
    if (followUp && init?.method === "POST") {
      cancelled.push(decodeURIComponent(followUp[1] ?? ""));
      return Response.json({ cancelled: true });
    }
    return fetchActivity(input, init);
  }) as typeof fetch;

  expect(await view.findByRole("heading", { name: "Scheduled" })).toBeTruthy();
  const followUpRow = view
    .getByText("Chase the invoice reply")
    .closest("[data-slot=item]") as HTMLElement;
  expect(followUpRow).toBeTruthy();
  const scheduled = view
    .getByRole("heading", { name: "Scheduled" })
    .closest("section") as HTMLElement;
  expect(scheduled.textContent).toContain("Run of Watch OpenBot releases");
  // The routine and the goal recur, so they are not under Scheduled.
  expect(scheduled.textContent).not.toContain("Check releases 1");
  const recurring = view
    .getByRole("heading", { name: "Recurring" })
    .closest("section") as HTMLElement;
  expect(recurring.textContent).toContain("Check releases 1");
  expect(recurring.textContent).toContain("Watch OpenBot releases");
  const routines = view.getByText("Routines").closest("a");
  expect(routines?.textContent).toContain("2 scheduled");
  expect(routines?.textContent).not.toContain("4 scheduled");

  const cancel = followUpRow.querySelector("button") as HTMLButtonElement;
  expect(cancel.textContent).toBe("Cancel");
  fireEvent.click(cancel);
  await waitFor(() => expect(cancelled).toEqual(["wake-up:42"]));
});

test("the newest three suggestions show, and the rest open in place", async () => {
  global.fetch = (async (input: RequestInfo | URL) => {
    if (pathOf(input) === CHECK_IN_ITEMS_PATH)
      return Response.json({
        nextCursor: null,
        checkInItems: Array.from({ length: 5 }, (_, index) => ({
          id: `s${index}`,
          botId: "scout",
          title: `Suggestion ${index + 1}`,
          detail: "",
          sourceApp: null,
          sourceLink: null,
          createdAt: "2026-10-09T10:00:00Z",
        })),
      });
    return Response.json({ error: "unexpected" }, { status: 404 });
  }) as typeof fetch;
  const view = render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <SuggestionsInbox agentId="scout" />
    </QueryClientProvider>,
  );

  expect(await view.findByText("Suggestion 3")).toBeTruthy();
  expect(view.queryByText("Suggestion 4")).toBeNull();
  fireEvent.click(view.getByRole("button", { name: "Show 2 more" }));
  expect(view.getByText("Suggestion 5")).toBeTruthy();
  expect(view.queryByRole("button", { name: /more$/ })).toBeNull();
});

function glance(
  data: Partial<BotActivity>,
  Component: typeof BotActivityGlance = BotActivityGlance,
  tasks: readonly unknown[] = [],
) {
  global.fetch = (async (input: RequestInfo | URL) =>
    String(input) === botOperationPath("scout", "activity")
      ? activityResponse(data)
      : // The person's tasks, which the Activity page lists beside the Bot's activity.
        pathOf(input) === `${ORGANIZATION_PATH}/tasks`
        ? Response.json({ tasks, nextCursor: null })
        : Response.json(
            { error: "unexpected" },
            { status: 404 },
          )) as typeof fetch;
  const router = createRouter({
    routeTree: createRootRoute({
      component: () => <Component agentId="scout" />,
    }),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  return render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

test("running and scheduled work shows on the Bot's page, running first, three at most", async () => {
  const view = glance({
    inProgress: items(2, "Running", true),
    scheduled: items(3, "Scheduled"),
    completed: items(9, "Done"),
  });

  expect(await view.findByText("Running 1")).toBeTruthy();
  const titles = [
    ...view.container.querySelectorAll("[data-slot=item-title]"),
  ].map((title) => title.textContent);
  expect(titles).toEqual([
    "Running 1",
    "Running 2",
    "Scheduled 1",
    "All activity",
  ]);
  expect(view.getByText("2 in progress · 3 scheduled")).toBeTruthy();
  expect(view.queryByText("Done 1")).toBeNull();
});

test("with nothing running or scheduled, there is no Activity section, and For you holds the one row", async () => {
  const idle = {
    inProgress: [],
    scheduled: [],
    completed: items(4, "Done"),
  };
  const section = glance(idle);
  const row = glance(idle, BotActivityRow);

  expect(await row.findByText("Nothing running or scheduled")).toBeTruthy();
  const titles = [
    ...row.container.querySelectorAll("[data-slot=item-title]"),
  ].map((title) => title.textContent);
  expect(titles).toEqual(["Activity"]);
  expect(section.container.querySelector("[data-slot=item]")).toBeNull();
  expect(section.queryByRole("heading", { name: "Activity" })).toBeNull();
});

/** One of the Bot's delegated tasks, as the API answers it. */
const botTask = (id: string, status: string, title: string) =>
  taskOf({
    id,
    agentId: "scout",
    channelId: `channel_${id}`,
    threadId: `thread_${id}`,
    title,
    why: null,
    origin: "delegated",
    suggestionId: null,
    sourceApp: null,
    sourceLink: null,
    originChannelId: "channel_main",
    status,
    failure: null,
    failedAt: null,
    next: null,
    resolvedAt: null,
    createdAt: "2026-10-09T10:00:00Z",
    updatedAt: "2026-10-09T10:00:00Z",
  });

/*
 * FOUND LIVE: the Bot page's Activity row said "No tasks, routines or goals yet" while the Activity
 * page it opens listed a finished task under Done. The row counted only the Bot's own activity and
 * not its tasks, which the Activity page lists beside it. It reads what the Activity page reads.
 */
test("the Activity row counts the Bot's tasks as the Activity page lists them", async () => {
  const idle = { inProgress: [], scheduled: [], completed: [] };
  const finished = glance(idle, BotActivityRow, [
    botTask("d", "ready_for_review", "Find Fremont Troll's origins"),
  ]);
  expect(
    await finished.findByText("Nothing running or scheduled"),
  ).toBeTruthy();
  expect(finished.queryByText("No tasks, routines or goals yet")).toBeNull();
  cleanup();

  const working = glance(idle, BotActivityRow, [
    botTask("w", "working", "Plan the offsite"),
    botTask("q", "needs_input", "Order the seeds"),
  ]);
  expect(await working.findByText("2 in progress")).toBeTruthy();
  cleanup();

  // And with nothing at all, it still says so.
  const none = glance(idle, BotActivityRow);
  expect(await none.findByText("No tasks, routines or goals yet")).toBeTruthy();
});

test("a long title is cut to one line with an ellipsis, and the whole of it shows on hover", async () => {
  // Seen on the Bot page: "...releases) and post one l", cut mid-word with nothing to say so.
  const long =
    "Check the latest release of CopilotKit/OpenBot on GitHub (https://github.com/CopilotKit/OpenBot/releases) and post one line in this conversation with its version number (tag) and release date.";
  const [scheduled] = items(1, "Scheduled");
  const view = glance({
    inProgress: [],
    scheduled: [{ ...(scheduled as ActivityItem), title: long }],
    completed: [],
  });

  const title = await view.findByText(long);
  expect(title.getAttribute("data-slot")).toBe("item-title");
  expect(title.getAttribute("title")).toBe(long);
  expect(title.className).toContain("truncate");
  // The row's content may shrink below its text, or the ellipsis never shows.
  expect(title.parentElement?.className).toContain("min-w-0");
});

test("a goal's activity row says Goal and opens the Bot's routines", async () => {
  const [running] = items(1, "Close the month");
  const view = glance({
    inProgress: [{ ...(running as ActivityItem), kind: "responsibility" }],
    scheduled: [],
    completed: [],
  });
  const title = await view.findByText("Close the month 1");
  const row = title.closest("a");
  expect(row?.getAttribute("href")).toBe("/bots/scout/routines");
  expect(row?.textContent).toContain("Goal · running");
  expect(row?.textContent).not.toMatch(/responsibilit/i);
});
