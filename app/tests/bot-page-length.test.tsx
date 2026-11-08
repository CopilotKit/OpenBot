import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, fireEvent, render } from "@testing-library/react";
import {
  activitySummary,
  BotActivityGlance,
  BotActivityRow,
  BotActivitySections,
} from "@/components/bot-profile/activity";
import { SuggestionsInbox } from "@/components/suggestions/proactive-panel";
import type { ActivityItem, BotActivity } from "@/lib/bot-lifecycle/queries";
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
test("a goal that runs only when asked is counted and listed as on demand, never as scheduled", async () => {
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

  const sections = glance(data, BotActivitySections);
  const scheduled = await sections.findByRole("heading", { name: "Scheduled" });
  const onDemand = sections.getByRole("heading", { name: "On demand" });
  const listedUnder = (heading: HTMLElement) =>
    [
      ...(heading
        .closest("section")
        ?.querySelectorAll("[data-slot=item-title]") ?? []),
    ].map((title) => title.textContent);
  expect(listedUnder(scheduled)).toEqual(["Check releases 1"]);
  expect(listedUnder(onDemand)).toEqual(["Watch OpenBot releases"]);
});

test("the newest three suggestions show, and the rest open in place", async () => {
  global.fetch = (async (input: RequestInfo | URL) => {
    if (String(input) === "/api/proactive/suggestions")
      return Response.json({
        suggestions: Array.from({ length: 5 }, (_, index) => ({
          id: `s${index}`,
          agentId: "scout",
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
  data: BotActivity,
  Component: typeof BotActivityGlance = BotActivityGlance,
) {
  global.fetch = (async (input: RequestInfo | URL) =>
    String(input).endsWith("/activity")
      ? Response.json({ activity: data })
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

test("a goal's activity row says Goal and opens the Bot's goals", async () => {
  const [running] = items(1, "Close the month");
  const view = glance({
    inProgress: [{ ...(running as ActivityItem), kind: "responsibility" }],
    scheduled: [],
    completed: [],
  });
  const title = await view.findByText("Close the month 1");
  const row = title.closest("a");
  expect(row?.getAttribute("href")).toBe("/bots/scout/responsibilities");
  expect(row?.textContent).toContain("Goal · running");
  expect(row?.textContent).not.toMatch(/responsibilit/i);
});
