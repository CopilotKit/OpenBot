import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, fireEvent, render, within } from "@testing-library/react";
import { BotRoutinesSection } from "@/components/routines/bot-routines";
import {
  backLabelFor,
  routinesOf,
} from "@/components/routines/new-routine-page";
import { RoutinesClock } from "@/components/routines/routines-clock";
import type { ProactiveSetting } from "@/lib/proactive";
import type { ResponsibilityRecord } from "@/lib/responsibilities";
import type { RoutineRecord } from "@/lib/routines/queries";
import { queryClient } from "@/query-client";
import { settleReactWork } from "./settle-react-work";

/**
 * A clock in a one-Bot conversation's header: how many of the Bot's routines are on, counted as its
 * page counts them, and one press lists all of them in a dialog without leaving the conversation.
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

const soon = (hours: number) =>
  new Date(Date.now() + hours * 3_600_000).toISOString();
const routine = (id: string, overrides: Partial<RoutineRecord> = {}) =>
  ({
    id,
    agentId: "scout",
    schedule: "Every weekday at 9:00",
    timezone: "UTC",
    instruction: `Do ${id}`,
    title: id,
    channel: { id: "c", name: null, title: null, gone: false },
    enabled: true,
    nextRunAt: soon(5),
    lastRun: { status: "succeeded", at: soon(-2) },
    goalId: null,
    ...overrides,
  }) satisfies RoutineRecord;
const goal = (id: string): ResponsibilityRecord => ({
  id,
  agentId: "scout",
  channelId: "c",
  threadId: "t",
  title: id,
  instruction: id,
  successCriteria: "",
  status: "active",
  progress: "",
  lastResult: null,
  subscriptions: [],
  recurring: false,
  endsWhenMet: false,
  updatedAt: soon(-1),
});
const checkIn = (
  id: string,
  overrides: Partial<ProactiveSetting> = {},
): ProactiveSetting => ({
  id,
  agentId: "scout",
  channelId: null,
  focus: "",
  subject: id,
  sourceKind: "app",
  reads: "Gmail",
  enabled: true,
  intervalMinutes: 1440,
  nextRunAt: soon(3),
  lastRunAt: null,
  lastStatus: "idle",
  lastError: null,
  lastRun: null,
  health: null,
  ...overrides,
});

function drawn(data: {
  routines?: RoutineRecord[];
  goals?: ResponsibilityRecord[];
  checkIns?: ProactiveSetting[];
}) {
  global.fetch = (async (input: RequestInfo | URL) => {
    const path = String(input);
    if (path === "/api/routines")
      return Response.json({
        routines: data.routines ?? [],
        sweep: { lastSweptAt: soon(0), working: true },
      });
    if (path === "/api/responsibilities")
      return Response.json({ responsibilities: data.goals ?? [] });
    if (path === "/api/proactive/settings")
      return Response.json({ settings: data.checkIns ?? [], allowed: true });
    if (path.endsWith("/activity"))
      return Response.json({
        activity: {
          inProgress: [],
          scheduled: [],
          onDemand: [],
          completed: [],
        },
      });
    if (path.endsWith("/lifecycle"))
      return Response.json({
        lifecycle: {
          agentId: "scout",
          paused: false,
          pausedAt: null,
          notify: "all",
        },
      });
    if (path === "/api/bots/attention")
      return Response.json({ bots: [], lastPingId: null, pausedAll: false });
    return Response.json({}, { status: 404 });
  }) as unknown as typeof fetch;
  const router = createRouter({
    routeTree: createRootRoute({
      component: () => (
        <>
          <RoutinesClock agentId="scout" botName="Scout" channelId="chat-1" />
          <BotRoutinesSection agentId="scout" botName="Scout" />
        </>
      ),
    }),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

test("the count is what is on, the same as the Bot's page, with a routine that runs a goal counted once", async () => {
  const view = drawn({
    routines: [
      routine("Standup"),
      routine("Runs the report", { goalId: "Report" }),
      routine("Off", { enabled: false }),
    ],
    goals: [goal("Report")],
    checkIns: [checkIn("Inbox"), checkIn("Quiet", { enabled: false })],
  });
  const clock = await view.findByRole("button", {
    name: "Scout's routines, 3 on",
  });
  expect(clock.textContent).toBe("3");
  expect(clock.querySelector("[data-needs-look]")).toBeNull();
  // The Bot's page says the same.
  expect(view.getByText("3 scheduled")).toBeTruthy();
});

test("no number at zero", async () => {
  const view = drawn({ routines: [routine("Off", { enabled: false })] });
  const clock = await view.findByRole("button", { name: "Scout's routines" });
  await settleReactWork();
  expect(clock.textContent).toBe("");
});

test("the count turns amber when one failed or can't look", async () => {
  const view = drawn({
    checkIns: [
      checkIn("Inbox", {
        health: {
          why: "Gmail isn't connected, so Scout can't check Inbox.",
          fix: "connect",
          app: { serverId: "gmail", title: "Gmail" },
        },
      }),
    ],
  });
  const clock = await view.findByRole("button", {
    name: "Scout's routines, 1 on",
  });
  expect(clock.querySelector("[data-needs-look]")).not.toBeNull();
});

test("the dialog lists every routine, on and off, each opening its page, which goes back to this conversation", async () => {
  const view = drawn({
    routines: [routine("Standup"), routine("Off", { enabled: false })],
  });
  fireEvent.click(
    await view.findByRole("button", { name: "Scout's routines, 1 on" }),
  );
  const dialog = await view.findByRole("dialog", { name: "Scout's routines" });
  expect(
    within(dialog).getByText("What it does by itself, for you."),
  ).toBeTruthy();
  const off = (await within(dialog).findByText("Off")).closest("a");
  expect(within(dialog).getByText("Standup")).toBeTruthy();
  expect(off?.getAttribute("href")).toBe(
    "/routines/schedules/Off?agentId=scout&from=chat-1",
  );
  expect(
    within(dialog)
      .getByRole("button", { name: "New routine" })
      .getAttribute("href"),
  ).toBe("/routines/new?agentId=scout&channelId=chat-1");
  expect(
    within(dialog)
      .getByRole("button", { name: "Open Routines" })
      .getAttribute("href"),
  ).toBe("/bots/scout/routines");
});

test("an empty dialog says how to get one", async () => {
  const view = drawn({});
  fireEvent.click(
    await view.findByRole("button", { name: "Scout's routines" }),
  );
  const dialog = await view.findByRole("dialog", { name: "Scout's routines" });
  expect(await within(dialog).findByText("No routines yet")).toBeTruthy();
  expect(
    within(dialog).getByText("Ask Scout here, or use New routine."),
  ).toBeTruthy();
});

test("a routine's page opened from a conversation goes back to it", () => {
  const back = routinesOf("scout", "chat-1");
  expect(back).toMatchObject({
    to: "/channel/$channelId",
    params: { channelId: "chat-1" },
  });
  expect(backLabelFor(back)).toBe("Conversation");
  expect(backLabelFor(routinesOf("scout"))).toBe("Routines");
});
