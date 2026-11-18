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
import { cronFrom, scheduleFrom } from "@/lib/routines/form";
import type { RoutineRecord } from "@/lib/routines/queries";
import { queryClient } from "@/query-client";
import { answerBotsList } from "./bots-api";
import { pathOf, ROUTINES_PATH, routineRunsPath } from "./schedules-api";
import { settleReactWork } from "./settle-react-work";

/*
 * Edit routine, on a routine's page. A routine could only be deleted and made again, which lost its
 * runs. Now its name, what it does, its schedule and its time zone change in place, through the
 * API's updateRoutine, and the page shows what was saved.
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

/** What the server says a cron is, for the ones these tests send. */
const WORDS: Record<string, string> = {
  "0 9 * * 1-5": "Weekdays at 09:00",
  "30 7 * * 3": "Wednesdays at 07:30",
  "0 9,17 * * *": "0 9,17 * * *",
};

/**
 * The server: one routine, changed by updateRoutine as the real one changes it, or refused with
 * `refusal`. Every change it was sent is kept, in order.
 */
function serving(
  routine: RoutineRecord = ROUTINE,
  refusal?: { status: number; detail: string },
) {
  let current = routine;
  const changes: Record<string, unknown>[] = [];
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = pathOf(input);
    const method = init?.method ?? "GET";
    if (path === `${ROUTINES_PATH}/${routine.id}` && method === "PATCH") {
      const body = JSON.parse(String(init?.body)) as Record<string, string>;
      changes.push(body);
      if (refusal)
        return Response.json(
          { status: refusal.status, detail: refusal.detail },
          {
            status: refusal.status,
            headers: { "content-type": "application/problem+json" },
          },
        );
      current = {
        ...current,
        ...(body.title !== undefined ? { title: body.title || null } : {}),
        ...(body.instruction !== undefined
          ? { instruction: body.instruction }
          : {}),
        ...(body.cron !== undefined
          ? { cron: body.cron, schedule: WORDS[body.cron] ?? body.cron }
          : {}),
        ...(body.timezone !== undefined ? { timezone: body.timezone } : {}),
      };
      return Response.json({ routine: current });
    }
    if (path === routineRunsPath(routine.id))
      return Response.json({ runs: [], nextCursor: null });
    if (path === ROUTINES_PATH)
      return Response.json({ routines: [current], nextCursor: null });
    const bots = answerBotsList(path, init, {
      visible: [
        { id: "lead-desk", name: "Lead Desk", avatarSeed: "lead-desk" },
      ],
      hidden: [],
    });
    if (bots) return bots;
    return Response.json({});
  }) as unknown as typeof fetch;
  return changes;
}

function draw(routine: RoutineRecord = ROUTINE) {
  const root = createRootRoute();
  const router = createRouter({
    history: createMemoryHistory({
      initialEntries: [`/routines/schedules/${routine.id}`],
    }),
    routeTree: root.addChildren([
      createRoute({
        getParentRoute: () => root,
        path: "/routines/schedules/$routineId",
        component: () => <RoutineRoutePage routineId={routine.id} />,
      }),
    ]),
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

/** What a person does to replace a field's text: select all of it, delete it, type the new. */
async function replaceText(
  user: ReturnType<typeof userEvent.setup>,
  field: HTMLElement,
  text: string,
) {
  await user.click(field);
  await user.keyboard("{Control>}a{/Control}{Delete}");
  if (text) await user.type(field, text);
}

async function openEdit(view: ReturnType<typeof draw>) {
  const user = userEvent.setup({ document });
  await user.click(await view.findByRole("button", { name: /^Edit routine/ }));
  const dialog = await view.findByRole("dialog", { name: "Edit routine" });
  return { user, dialog: within(dialog) };
}

test("the picker reads back exactly the schedules it writes, and no others", () => {
  for (const schedule of [
    { repeat: "daily", time: "08:15", weekday: "1", monthDay: "1" },
    { repeat: "weekdays", time: "09:00", weekday: "1", monthDay: "1" },
    { repeat: "weekly", time: "07:30", weekday: "3", monthDay: "1" },
    { repeat: "monthly", time: "18:45", weekday: "1", monthDay: "28" },
    { repeat: "hourly", time: "09:00", weekday: "1", monthDay: "1" },
  ] as const)
    expect(scheduleFrom(cronFrom(schedule))).toEqual(schedule);
  // What a Bot can write and the picker can't say.
  for (const cron of [
    "*/15 * * * *",
    "0 9,17 * * *",
    "0 9 * * 1,3",
    "0 9 31 * *",
    "0 9 1 1 *",
    "15 * * * *",
    "0 9 * * 7",
  ])
    expect(scheduleFrom(cron)).toBeNull();
});

test("Edit routine opens with what the routine is now", async () => {
  serving();
  const view = draw();
  const { dialog } = await openEdit(view);
  expect((dialog.getByLabelText("Name") as HTMLInputElement).value).toBe(
    "Morning leads",
  );
  expect(
    (dialog.getByLabelText("What to do") as HTMLTextAreaElement).value,
  ).toBe(ROUTINE.instruction);
  expect(dialog.getByLabelText("Schedule").textContent).toContain(
    "Every weekday",
  );
  expect((dialog.getByLabelText("Time") as HTMLInputElement).value).toBe(
    "09:00",
  );
  expect((dialog.getByLabelText("Time zone") as HTMLInputElement).value).toBe(
    "Europe/Madrid",
  );
});

test("saving changes what to do and when it runs, and the page shows it", async () => {
  const changes = serving();
  const view = draw();
  const { user, dialog } = await openEdit(view);
  await replaceText(
    user,
    dialog.getByLabelText("What to do"),
    "Send me this week's new leads",
  );
  await user.click(dialog.getByLabelText("Schedule"));
  await user.click(await view.findByRole("option", { name: "Every week" }));
  await user.click(await view.findByLabelText("Day of the week"));
  await user.click(await view.findByRole("option", { name: "Wednesday" }));
  await replaceText(user, dialog.getByLabelText("Time"), "07:30");
  expect(
    dialog.getByText("Every Wednesday at 7:30 AM", { exact: false }),
  ).toBeTruthy();
  await user.click(dialog.getByRole("button", { name: "Save changes" }));

  await waitFor(() =>
    expect(view.queryByRole("dialog", { name: "Edit routine" })).toBeNull(),
  );
  // Only what changed was sent: the name and the time zone were left alone.
  expect(changes).toEqual([
    { instruction: "Send me this week's new leads", cron: "30 7 * * 3" },
  ]);
  await view.findByText("Send me this week's new leads");
  expect(
    (await view.findAllByText("Wednesdays at 07:30")).length,
  ).toBeGreaterThan(0);
});

test("a schedule the picker can't say is kept unless another is picked", async () => {
  const custom: RoutineRecord = {
    ...ROUTINE,
    cron: "0 9,17 * * *",
    schedule: "0 9,17 * * *",
  };
  const changes = serving(custom);
  const view = draw(custom);
  const { user, dialog } = await openEdit(view);
  expect(dialog.getByLabelText("Schedule").textContent).toContain(
    "0 9,17 * * *",
  );
  // No time to pick while it is kept: the schedule is the one it has.
  expect(dialog.queryByLabelText("Time")).toBeNull();
  await replaceText(user, dialog.getByLabelText("Name"), "Twice-daily leads");
  await user.click(dialog.getByRole("button", { name: "Save changes" }));
  await waitFor(() =>
    expect(view.queryByRole("dialog", { name: "Edit routine" })).toBeNull(),
  );
  expect(changes).toEqual([{ title: "Twice-daily leads" }]);
});

test("a refusal is said in the dialog, which stays open", async () => {
  const changes = serving(ROUTINE, {
    status: 400,
    detail: "Routines may run at most every 15 minutes.",
  });
  const view = draw();
  const { user, dialog } = await openEdit(view);
  await user.click(dialog.getByLabelText("Schedule"));
  await user.click(await view.findByRole("option", { name: "Every hour" }));
  await user.click(dialog.getByRole("button", { name: "Save changes" }));
  expect((await dialog.findByRole("alert")).textContent).toBe(
    "Routines may run at most every 15 minutes.",
  );
  expect(view.getByRole("dialog", { name: "Edit routine" })).toBeTruthy();
  expect(changes).toEqual([{ cron: "0 * * * *" }]);
});

test("an empty What to do is not saved", async () => {
  const changes = serving();
  const view = draw();
  const { user, dialog } = await openEdit(view);
  await replaceText(user, dialog.getByLabelText("What to do"), "");
  await user.click(dialog.getByRole("button", { name: "Save changes" }));
  expect(await dialog.findByText("Say what the Bot should do.")).toBeTruthy();
  expect(changes).toEqual([]);
});
