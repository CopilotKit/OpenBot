import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { viewerTimeZone } from "@/components/routines/routine-page";
import { RoutinesHome } from "@/components/routines/routines-home";
import type { RoutineRecord } from "@/lib/routines/queries";
import { queryClient } from "@/query-client";
import { ME_PATH, meBody, PREFERENCES_PATH } from "./accounts-api";
import { answerBotsList, BOTS_PATH } from "./bots-api";
import { answerScheduleLists, pathOf, ROUTINES_PATH } from "./schedules-api";
import { settleReactWork } from "./settle-react-work";

/**
 * The Routines page: one box, then the routines grouped by Bot, then nothing else: the check-ins switch is in Settings → Notifications.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(() => {
  cleanup();
  queryClient.clear();
  window.localStorage.clear();
});
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
});

const routine = (overrides: Partial<RoutineRecord> = {}): RoutineRecord => ({
  id: "r1",
  botId: "atlas",
  schedule: "Every weekday at 9:00",
  cron: "0 9 * * 1-5",
  timezone: viewerTimeZone(),
  instruction: "Post the standup summary.",
  title: "Standup summary",
  conversation: { id: "c1", name: null, title: "Standup", gone: false },
  enabled: true,
  nextRunAt: "2999-01-01T09:00:00.000Z",
  lastRun: null,
  goalId: null,
  createdAt: "2026-10-09T10:00:00Z",
  ...overrides,
});

const bot = (id: string, name: string) => ({ id, name, avatarSeed: id });

let writes: string[] = [];

function serving({
  shown = [] as unknown[],
  hidden = [] as unknown[],
  routines = [] as unknown[],
  routinesFail = false,
  botsFail = false,
}: {
  shown?: unknown[];
  hidden?: unknown[];
  routines?: unknown[];
  routinesFail?: boolean;
  botsFail?: boolean;
} = {}) {
  writes = [];
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (method !== "GET") {
      writes.push(`${method} ${pathOf(input)}`);
      return Response.json({});
    }
    if (routinesFail && pathOf(input) === ROUTINES_PATH)
      return new Response(null, { status: 500 });
    if (pathOf(input) === ME_PATH)
      return Response.json(meBody({ user: { id: "u1" } }));
    if (pathOf(input) === PREFERENCES_PATH)
      return Response.json({ proactive: "on" });
    if (botsFail && pathOf(input) === BOTS_PATH)
      return new Response(null, { status: 500 });
    const bots = answerBotsList(input, init, { visible: shown, hidden });
    if (bots) return bots;
    const lists = answerScheduleLists(input, init, { routines });
    if (lists) return lists;
    return Response.json({});
  }) as unknown as typeof fetch;
}

function draw() {
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: createRootRoute({ component: RoutinesHome }),
  });
  // A client that doesn't retry, so a failed read is said at once.
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

const groupNames = (view: ReturnType<typeof draw>) =>
  view.getAllByRole("region").map((group) => group.getAttribute("aria-label"));

test("the heading and the line under it", async () => {
  serving({ shown: [bot("atlas", "Atlas")] });
  const view = draw();
  const heading = await view.findByRole("heading", { level: 1 });
  expect(heading.textContent).toBe("Give your Bots some work");
  expect(
    view.getByText(
      "Routines run on a schedule, towards a goal or wake up the Bot if they expect something from the outside.",
    ),
  ).toBeTruthy();
});

test("the groups follow the shown Bots' order, a hidden Bot's group last", async () => {
  serving({
    // Atlas is listed before Juno, so its group is too, whatever order the routines came in.
    shown: [bot("atlas", "Atlas"), bot("juno", "Juno")],
    hidden: [bot("scout", "Scout")],
    routines: [
      routine({ id: "r-scout", botId: "scout", title: "Scout's one" }),
      routine({ id: "r-juno", botId: "juno", title: "Juno's one" }),
      routine({ id: "r-atlas", botId: "atlas", title: "Atlas's one" }),
    ],
  });
  const view = draw();
  await view.findByText("Scout's one");
  expect(groupNames(view)).toEqual(["Atlas", "Juno", "Scout"]);
  // Each routine is in its own Bot's group.
  const atlas = view.getByRole("region", { name: "Atlas" });
  expect(atlas.textContent).toContain("Atlas's one");
  expect(atlas.textContent).not.toContain("Juno's one");
});

test("the empty page shows three examples, and pressing one fills the box and sends nothing", async () => {
  serving({ shown: [bot("atlas", "Atlas")] });
  const view = draw();
  const box = await view.findByRole("textbox", { name: "Message" });
  await waitFor(() => expect(box.getAttribute("contenteditable")).toBe("true"));

  const examples = [
    "Every weekday at 9, send me yesterday's new leads",
    "Every Friday at 4, summarize what changed in my projects this week",
    "Keep an eye on my inbox and tell me when a customer writes",
  ];
  for (const example of examples) {
    const button = view.getByRole("button", { name: example });
    // A long example wraps inside the column instead of scrolling the page sideways.
    expect(button.className).toContain("whitespace-normal");
    expect(button.className).not.toContain("whitespace-nowrap");
  }

  const user = userEvent.setup({ document });
  await user.click(view.getByRole("button", { name: examples[1] as string }));
  // The box is drawn again with the example in it.
  await waitFor(() =>
    expect(view.getByRole("textbox", { name: "Message" }).textContent).toBe(
      examples[1] as string,
    ),
  );
  await settleReactWork();
  expect(writes).toEqual([]);
});

test("a page with routines shows no examples", async () => {
  serving({
    shown: [bot("atlas", "Atlas")],
    routines: [routine()],
  });
  const view = draw();
  await view.findByText("Standup summary");
  expect(
    view.queryByRole("button", {
      name: "Every weekday at 9, send me yesterday's new leads",
    }),
  ).toBeNull();
});

test("a failed read says so, shows no examples, and keeps the box", async () => {
  serving({ shown: [bot("atlas", "Atlas")], routinesFail: true });
  const view = draw();
  const alert = await view.findByRole("alert");
  expect(alert.textContent).toBe(
    "Couldn't load your routines. Try again in a moment.",
  );
  expect(view.getByRole("textbox", { name: "Message" })).toBeTruthy();
  expect(
    view.queryByRole("button", {
      name: "Every weekday at 9, send me yesterday's new leads",
    }),
  ).toBeNull();
});

test("a failed Bots read says so", async () => {
  serving({
    botsFail: true,
    routines: [routine({ botId: "atlas", title: "Standup summary" })],
  });
  const view = draw();
  const alert = await view.findByRole("alert");
  expect(alert.textContent).toBe(
    "Couldn't load your Bots. Try again in a moment.",
  );
});

test("the Routines page has no check-ins switch: it lives in Settings → Notifications", async () => {
  serving({ shown: [bot("atlas", "Atlas")] });
  const view = draw();
  await view.findByRole("heading", { level: 1 });
  // Long enough for the preferences read the switch used to wait on.
  await new Promise((resolve) => setTimeout(resolve, 100));
  await settleReactWork();
  expect(view.queryByRole("switch")).toBeNull();
  expect(view.queryByText(/Check-ins from all/)).toBeNull();
});
