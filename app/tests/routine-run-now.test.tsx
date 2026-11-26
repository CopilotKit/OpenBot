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
import { cleanup, render, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RoutineRoutePage } from "@/components/routines/routine-page";
import type { RoutineRecord } from "@/lib/routines/queries";
import { queryClient } from "@/query-client";
import { answerBotsList } from "./bots-api";
import { pathOf, ROUTINES_PATH, routineRunsPath } from "./schedules-api";
import { settleReactWork } from "./settle-react-work";

/*
 * Run now, on a routine's page. Pressing it started the run and said nothing: the row looked the
 * same before and after, and the run only showed up later in the Runs list further down. Now the
 * row says it is starting while the server is asked, and once the server accepts the run the page
 * says it started and links to the conversation the Bot posts in.
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

const RUN_ID = "0f1e2d3c-4b5a-4968-8776-5a4b3c2d1e0f";

/**
 * The server: one routine, and runRoutine answering as the real one does, 202 with the run it
 * started, which then shows in the routine's runs. `hold` keeps the run's answer back until it is
 * let go; `refusal` answers with a problem instead.
 */
function serving({
  routine = ROUTINE,
  hold,
  refusal,
}: {
  routine?: RoutineRecord;
  hold?: Promise<void>;
  refusal?: { status: number; detail: string };
} = {}) {
  const runs: unknown[] = [];
  const presses: string[] = [];
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = pathOf(input);
    const method = (init?.method ?? "GET").toUpperCase();
    if (path === `${ROUTINES_PATH}/${routine.id}/run` && method === "POST") {
      presses.push(path);
      if (hold) await hold;
      if (refusal)
        return Response.json(
          { status: refusal.status, detail: refusal.detail },
          {
            status: refusal.status,
            headers: { "content-type": "application/problem+json" },
          },
        );
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
    if (path === routineRunsPath(routine.id))
      return Response.json({ runs, nextCursor: null });
    if (path === ROUTINES_PATH)
      return Response.json({ routines: [routine], nextCursor: null });
    const bots = answerBotsList(path, init, {
      visible: [
        { id: "lead-desk", name: "Lead Desk", avatarSeed: "lead-desk" },
      ],
      hidden: [],
    });
    if (bots) return bots;
    return Response.json({});
  }) as unknown as typeof fetch;
  return presses;
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
      createRoute({
        getParentRoute: () => root,
        path: "/channel/$channelId",
        component: () => <p>A conversation</p>,
      }),
    ]),
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

const RUN_BUTTON = `Run the routine scheduled ${ROUTINE.schedule} now`;

test("Run now says it started and links to the conversation the Bot posts in", async () => {
  const presses = serving();
  const view = draw();
  const user = userEvent.setup({ document });
  // Nothing is said before it is pressed.
  await view.findByRole("button", { name: RUN_BUTTON });
  expect(view.queryByText(/^Started\./)).toBeNull();

  await user.click(view.getByRole("button", { name: RUN_BUTTON }));

  const said = await view.findByText(/^Started\./);
  const status = said.closest("[role=status]") as HTMLElement;
  expect(status).toBeTruthy();
  expect(status.textContent).toContain(
    "Started. The Bot posts in the conversation as it works.",
  );
  const link = within(status).getByRole("link", { name: "Open conversation" });
  expect(link.getAttribute("href")).toBe("/channel/conversation-1");
  expect(presses).toEqual([`${ROUTINES_PATH}/${ROUTINE.id}/run`]);

  // The link goes where the run shows.
  await user.click(link);
  await view.findByText("A conversation");
});

test("while the server is asked, the row says it is starting and can't be pressed again", async () => {
  let release = () => {};
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const presses = serving({ hold });
  const view = draw();
  const user = userEvent.setup({ document });
  await user.click(await view.findByRole("button", { name: RUN_BUTTON }));

  const row = view.getByRole("button", { name: RUN_BUTTON });
  await within(row).findByText("Starting…");
  expect((row as HTMLButtonElement).disabled).toBe(true);

  release();
  await view.findByText(/^Started\./);
  expect(within(row).getByText("Run now")).toBeTruthy();
  expect(presses).toHaveLength(1);
});

test("a routine whose conversation was deleted says the run shows under Runs", async () => {
  const gone: RoutineRecord = {
    ...ROUTINE,
    conversation: { ...ROUTINE.conversation, gone: true },
  };
  serving({ routine: gone });
  const view = draw(gone);
  const user = userEvent.setup({ document });
  await user.click(await view.findByRole("button", { name: RUN_BUTTON }));
  const said = await view.findByText("Started. It shows under Runs.");
  expect(said.getAttribute("role")).toBe("status");
});

test("a refused run says why, and never says it started", async () => {
  serving({
    refusal: { status: 400, detail: "This routine is already running." },
  });
  const view = draw();
  const user = userEvent.setup({ document });
  await user.click(await view.findByRole("button", { name: RUN_BUTTON }));
  expect((await view.findByRole("alert")).textContent).toBe(
    "This routine is already running.",
  );
  expect(view.queryByText(/^Started\./)).toBeNull();
});
