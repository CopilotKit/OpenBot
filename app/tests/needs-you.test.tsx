import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import {
  cleanup,
  fireEvent,
  render,
  waitFor,
  within,
} from "@testing-library/react";
import { BotRoster } from "@/components/bots/bot-roster";
import { BotNeedsYou } from "@/components/needs-you/board";
import { taskKeys } from "@/lib/tasks/queries";
import { queryClient } from "@/query-client";
import {
  TASKS_VIEW_STORAGE_KEY,
  TasksScreen,
  type TasksView,
} from "@/skins/openduet/tasks-screen";
import { NotificationsSheet } from "@/skins/openfuse/notifications-sheet";
import { APPROVALS_PATH, approvalInboxResponse } from "./approvals-api";
import {
  activityOf,
  answerBotAttention,
  answerBotsList,
  attentionOf,
  botOperationPath,
} from "./bots-api";
import {
  CONVERSATIONS_PATH,
  conversationPage,
  problem,
  TASKS_PATH,
  taskOf,
} from "./conversations-api";
import {
  answerScheduleLists,
  CHECK_IN_ITEMS_PATH,
  ORGANIZATION_PATH,
  pathOf,
} from "./schedules-api";
import { settleReactWork } from "./settle-react-work";

/*
 * What a Bot's check-ins found and the tasks started from them, where the person meets them: the
 * Bots page's Needs you, the Bot's own page, and the OpenDuet skin's Tasks. All three are drawn at
 * once, in one cache, against a fake of OpenBot's API that keeps state the way the real routes do:
 * Dismiss takes an item off the open list, Work on it takes it off and opens a task, and a task's actions
 * move its status. The fake answers in the shapes `server/src/proactive/contracts.ts` promises.
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
  window.localStorage.clear();
});

const now = new Date().toISOString();

type Item = {
  id: string;
  botId: string;
  title: string;
  detail: string;
  sourceApp: string | null;
  sourceRef: string | null;
  sourceLink: string | null;
  pingId: string | null;
  createdAt: string;
};

type Task = {
  id: string;
  agentId: string;
  channelId: string;
  threadId: string | null;
  title: string;
  why: string | null;
  origin: "check_in" | "delegated";
  suggestionId: string | null;
  sourceApp: string | null;
  sourceLink: string | null;
  status:
    | "needs_input"
    | "working"
    | "resolved"
    | "failed"
    | "ready_for_review";
  failure: string | null;
  failedAt: string | null;
  stoppedAt?: string | null;
  canTryAgain?: boolean;
  next: string | null;
  resolvedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

const item = (overrides: Partial<Item> & { id: string; title: string }) => ({
  botId: "inbox",
  detail: "Dana asked for the Q3 numbers by Friday.",
  sourceApp: "Gmail",
  sourceRef: "gmail/message/1",
  sourceLink: "https://mail.example.com/1",
  pingId: "ping-1",
  createdAt: now,
  ...overrides,
});

const task = (overrides: Partial<Task> & { id: string; title: string }) => ({
  agentId: "inbox",
  channelId: `c-${overrides.id}`,
  threadId: `t-${overrides.id}`,
  why: null,
  origin: "check_in" as const,
  suggestionId: null,
  sourceApp: "Gmail",
  sourceLink: null,
  status: "ready_for_review" as const,
  failure: null,
  failedAt: null,
  next: null,
  resolvedAt: null,
  createdAt: now,
  updatedAt: now,
  ...overrides,
});

let items: Item[] = [];
let tasks: Task[] = [];
let questions: {
  id: string;
  botId: string;
  threadId: string;
  channelId?: string;
  question: string;
  createdAt: string;
}[] = [];
/** Reads that fail right now, by path, to test a board drawn from some sources and not others. */
let failing = new Set<string>();
/** Conversations a turn is running in right now, as the sidebar's live list says. */
let busy: string[] = [];
/** What each Bot is waiting on the person for, as the server counts it. */
let waitingBots: ReturnType<typeof attentionOf>[] = [];
/** Actions waiting on the person, as the inbox lists them. */
let requests: unknown[] = [];
/** What the Inbox Bot's Activity lists under way: a hand-off that ran out of tries, when a test says. */
let stalled: ReturnType<typeof activityOf>["inProgress"] = [];
const sent: { method: string; path: string }[] = [];

function serving() {
  sent.length = 0;
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    // A list in the API is asked for with `limit`; the address is what names it.
    const path = String(input).startsWith(ORGANIZATION_PATH)
      ? pathOf(input)
      : String(input);
    const method = init?.method ?? "GET";
    if (method !== "GET") sent.push({ method, path });
    if (method === "GET" && failing.has(path))
      // The API refuses with a problem document; the routes not yet in it with `{ error }`.
      return path.startsWith(ORGANIZATION_PATH)
        ? problem(500, "Server error")
        : Response.json({ error: "Server error" }, { status: 500 });
    const started = path.startsWith(`${CHECK_IN_ITEMS_PATH}/`)
      ? path.slice(CHECK_IN_ITEMS_PATH.length).match(/^\/(.+)\/start$/)
      : null;
    if (started) {
      const found = items.find((entry) => entry.id === started[1]);
      if (!found) return Response.json({ error: "Not open" }, { status: 404 });
      items = items.filter((entry) => entry !== found);
      const opened = task({
        id: `task-${found.id}`,
        agentId: found.botId,
        title: found.title,
        why: found.detail,
        suggestionId: found.id,
        status: "working",
      });
      tasks = [opened, ...tasks];
      return Response.json({
        checkInItem: { ...found, status: "started" },
        task: { id: opened.id, conversationId: opened.channelId },
      });
    }
    const hidden = path.startsWith(`${CHECK_IN_ITEMS_PATH}/`)
      ? path.slice(CHECK_IN_ITEMS_PATH.length).match(/^\/(.+)\/dismiss$/)
      : null;
    if (hidden) {
      const found = items.find((entry) => entry.id === hidden[1]);
      items = items.filter((entry) => entry !== found);
      return Response.json({ checkInItem: { ...found, status: "dismissed" } });
    }
    const acted = path.match(
      /^\/api\/v2\/organizations\/default\/tasks\/(.+)\/(resolve|reopen|retry|stop)$/,
    );
    if (acted) {
      const [, id, action] = acted;
      tasks = tasks.map((entry) =>
        entry.id !== id
          ? entry
          : action === "resolve"
            ? { ...entry, status: "resolved", resolvedAt: now }
            : action === "reopen"
              ? { ...entry, status: "ready_for_review", resolvedAt: null }
              : action === "stop"
                ? {
                    ...entry,
                    status: "failed",
                    failure: "you stopped it",
                    failedAt: now,
                    stoppedAt: now,
                  }
                : { ...entry, status: "working", failure: null },
      );
      const found = tasks.find((entry) => entry.id === id);
      return found
        ? Response.json({ task: taskOf(found) })
        : problem(404, "Couldn't find that task.");
    }
    if (path === CHECK_IN_ITEMS_PATH)
      return Response.json({ checkInItems: items, nextCursor: null });
    if (path === TASKS)
      return Response.json({ tasks: tasks.map(taskOf), nextCursor: null });
    if (path.split("?")[0] === CONVERSATIONS_PATH)
      return Response.json(
        conversationPage(
          busy.map((id) => ({
            id,
            name: "Task",
            agentIds: ["inbox"],
            threadId: `t-${id}`,
            active: true,
            lastMessageAt: now,
            summary: null,
            lastMessage: null,
            lastMessageAgentId: null,
            createdAt: now,
            pinned: false,
            lastReadAt: now,
            busy: true,
          })),
        ),
      );
    {
      const approvals = approvalInboxResponse(path, {
        enabled: true,
        rules: [],
        teamRules: [],
        requests: requests as never[],
        questions,
      });
      if (approvals) return approvals;
    }
    if (path === botOperationPath("inbox", "activity"))
      return Response.json(activityOf({ inProgress: stalled }));
    const waiting = answerBotAttention(input, init, { bots: waitingBots });
    if (waiting) return waiting;
    const schedules = answerScheduleLists(input, init);
    if (schedules) return schedules;
    const bots = answerBotsList(input, init, {
      visible: [
        { id: "inbox", name: "Inbox Bot", mine: true },
        { id: "ops", name: "Ops Bot", mine: true },
      ],
      hidden: [],
    });
    if (bots) return bots;
    return Response.json({ error: "not served" }, { status: 404 });
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  items = [];
  tasks = [];
  questions = [];
  failing = new Set();
  busy = [];
  waitingBots = [];
  stalled = [];
  requests = [];
  // Work on it, Dismiss and a task's actions invalidate the app's one cache, so the lists draw from it.
  queryClient.clear();
});

/**
 * The Bots page, the Inbox Bot's page and OpenDuet's Tasks, side by side, OpenDuet on its Up next
 * list unless a test opens Active.
 */
async function drawAll(duet: TasksView = "up_next") {
  window.localStorage.setItem(TASKS_VIEW_STORAGE_KEY, duet);
  const rootRoute = createRootRoute();
  const routeTree = rootRoute.addChildren([
    createRoute({
      getParentRoute: () => rootRoute,
      path: "/",
      component: () => (
        <>
          <section aria-label="Bots page">
            <BotRoster />
          </section>
          <section aria-label="Bot page">
            <BotNeedsYou agentId="inbox" />
          </section>
          <section aria-label="OpenDuet">
            <TasksScreen />
          </section>
        </>
      ),
    }),
    createRoute({
      getParentRoute: () => rootRoute,
      path: "/bots/$agentId",
      component: () => null,
    }),
    createRoute({
      getParentRoute: () => rootRoute,
      path: "/channel/$channelId",
      component: () => null,
    }),
  ]);
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  // Resolved before the first render, so the page is on screen from the start and stays there.
  await router.load();
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
  const region = (name: string) => within(view.getByRole("region", { name }));
  return { view, region };
}

/** OpenFuse's bell, opened: its sheet of what every Bot waits on the person for. */
async function drawBell() {
  const rootRoute = createRootRoute({
    component: () => <NotificationsSheet onClose={() => {}} />,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      createRoute({
        getParentRoute: () => rootRoute,
        path: "/channel/$channelId",
        component: () => null,
      }),
    ]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  await router.load();
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
  return within(await within(document.body).findByRole("dialog"));
}

test("an item says what it is, why, which Bot found it and where, with Work on it and Dismiss", async () => {
  items = [item({ id: "s1", title: "Send Dana the Q3 numbers" })];
  serving();
  const { view, region } = await drawAll();
  await view.findAllByText("Send Dana the Q3 numbers");
  const bots = region("Bots page");
  expect(bots.getByRole("heading", { name: "Needs you" })).toBeTruthy();
  expect(
    bots.getByText("Dana asked for the Q3 numbers by Friday."),
  ).toBeTruthy();
  // Under its Bot's header, from the app it was read with.
  expect(bots.getByText("From check-ins")).toBeTruthy();
  expect(bots.getByText("· from its check-ins")).toBeTruthy();
  expect(bots.getByText("Gmail")).toBeTruthy();
  expect(bots.getByRole("button", { name: "Work on it" })).toBeTruthy();
  expect(
    bots.getByRole("button", { name: "Dismiss Send Dana the Q3 numbers" }),
  ).toBeTruthy();
  const open = bots.getByRole("link", { name: "Open mail.example.com" });
  expect(open.getAttribute("href")).toBe("https://mail.example.com/1");
  expect(open.getAttribute("target")).toBe("_blank");
});

test("Open names the site its link goes to, never the app the Bot read it with", async () => {
  items = [
    item({
      id: "s1",
      title: "Review Bun 1.4.4 release notes",
      sourceApp: "Exa Search",
      sourceRef: "exa/search",
      sourceLink: "https://www.bun.com/blog/bun-v1.4.4",
    }),
  ];
  serving();
  const { view, region } = await drawAll();
  await view.findAllByText("Review Bun 1.4.4 release notes");
  const bots = region("Bots page");
  expect(bots.getByText("Exa Search")).toBeTruthy();
  expect(bots.queryByRole("link", { name: /Exa Search/ })).toBeNull();
  const open = bots.getByRole("link", { name: "Open bun.com" });
  expect(open.getAttribute("href")).toBe("https://www.bun.com/blog/bun-v1.4.4");
});

test("Dismiss takes an item off the Bots page, the Bot's page and OpenDuet at once", async () => {
  items = [
    item({ id: "s1", title: "Send Dana the Q3 numbers" }),
    item({ id: "s2", title: "Renew the studio insurance" }),
  ];
  serving();
  const { view, region } = await drawAll();
  await waitFor(() =>
    expect(view.getAllByText("Send Dana the Q3 numbers")).toHaveLength(3),
  );
  const row = region("Bot page")
    .getByText("Send Dana the Q3 numbers")
    .closest("[data-slot=item]") as HTMLElement;
  fireEvent.click(
    within(row).getByRole("button", {
      name: "Dismiss Send Dana the Q3 numbers",
    }),
  );
  await waitFor(() =>
    expect(view.queryAllByText("Send Dana the Q3 numbers")).toHaveLength(0),
  );
  expect(sent).toContainEqual({
    method: "POST",
    path: `${CHECK_IN_ITEMS_PATH}/s1/dismiss`,
  });
  // The other item stays on all three.
  expect(view.getAllByText("Renew the studio insurance")).toHaveLength(3);
});

test("Work on it takes the item off and shows its task, Working, opening its own conversation", async () => {
  items = [item({ id: "s1", title: "Send Dana the Q3 numbers" })];
  serving();
  const { view, region } = await drawAll();
  const bots = region("Bots page");
  fireEvent.click(await bots.findByRole("button", { name: "Work on it" }));
  await waitFor(() => expect(bots.getByText("Working")).toBeTruthy());
  expect(sent).toEqual([
    { method: "POST", path: `${CHECK_IN_ITEMS_PATH}/s1/start` },
  ]);
  // The item became the task: nothing left to start or dismiss for it anywhere.
  expect(view.queryAllByRole("button", { name: "Work on it" })).toHaveLength(0);
  expect(bots.getByText("Just started.")).toBeTruthy();
  const row = bots
    .getByText("Send Dana the Q3 numbers")
    .closest("[data-slot=item]") as HTMLElement;
  expect(
    within(row).getByRole("button", { name: "Open" }).getAttribute("href"),
  ).toBe("/channel/c-task-s1");
  // The Bot's own page lists it too.
  expect(region("Bot page").getByText("Working")).toBeTruthy();
});

test("tasks list what to read, answer and retry first, and each acts from its row", async () => {
  tasks = [
    task({ id: "w", title: "Draft the board update", status: "working" }),
    task({
      id: "f",
      title: "File the expense report",
      status: "failed",
      failure: "Gmail stopped answering",
    }),
    task({
      id: "r",
      title: "Reply to the landlord",
      status: "ready_for_review",
      next: "I drafted a reply. Want me to send it?",
    }),
    task({ id: "n", title: "Book the venue", status: "needs_input" }),
  ];
  serving();
  const { region } = await drawAll();
  const bots = region("Bots page");
  await bots.findByText("Reply to the landlord");
  const titles = [
    ...(bots
      .getByRole("heading", { name: "Needs you" })
      .closest("section")
      ?.querySelectorAll("[data-slot=item-title]") ?? []),
  ].map((title) => title.textContent);
  expect(titles).toEqual([
    "Reply to the landlord",
    "Book the venue",
    "File the expense report",
    "Draft the board update",
  ]);
  expect(bots.getByText("I drafted a reply. Want me to send it?")).toBeTruthy();
  expect(bots.getByText("Gmail stopped answering.")).toBeTruthy();

  fireEvent.click(bots.getByRole("button", { name: "Try again" }));
  await waitFor(() =>
    expect(sent).toContainEqual({
      method: "POST",
      path: "/api/v2/organizations/default/tasks/f/retry",
    }),
  );
  await waitFor(() =>
    expect(bots.queryByText("Gmail stopped answering.")).toBeNull(),
  );

  const ready = bots
    .getByText("Reply to the landlord")
    .closest("[data-slot=item]") as HTMLElement;
  fireEvent.click(within(ready).getByRole("button", { name: "Mark done" }));
  // Marked done, it leaves Needs you for the folded Done list, where it can be reopened.
  const done = await bots.findByRole("heading", { name: "Done" });
  const section = within(done.closest("section") as HTMLElement);
  expect(section.getByText("1 task you marked done this week.")).toBeTruthy();
  fireEvent.click(section.getByRole("button", { name: "Show done tasks" }));
  fireEvent.click(section.getByRole("button", { name: "Reopen" }));
  await waitFor(() =>
    expect(sent).toContainEqual({
      method: "POST",
      path: "/api/v2/organizations/default/tasks/r/reopen",
    }),
  );
  await waitFor(() =>
    expect(bots.queryByRole("heading", { name: "Done" })).toBeNull(),
  );
});

test("a task the person stopped reads Stopped on the board, in its card's words, and can be tried again", async () => {
  tasks = [
    task({
      id: "s",
      title: "Chase the supplier",
      status: "failed",
      failure: "you stopped it",
      failedAt: now,
      stoppedAt: now,
    }),
    task({
      id: "f",
      title: "File the expense report",
      status: "failed",
      failure: "Gmail stopped answering",
      failedAt: now,
    }),
  ];
  // The server counts both as failed, since that is the status of both.
  waitingBots = [
    attentionOf("inbox", "Inbox Bot", {
      tasks: { needsInput: 0, ready: 0, failed: 2 },
    }),
  ];
  serving();
  const { region } = await drawAll();
  // The Bot's row in the list says which was which.
  expect(
    await region("Bots page").findByText("1 failed task, 1 stopped task"),
  ).toBeTruthy();
  // The Bots page and the Bot's own page draw the same board.
  for (const name of ["Bots page", "Bot page"]) {
    const surface = region(name);
    const stopped = within(
      (await surface.findByText("Chase the supplier")).closest(
        "[data-slot=item]",
      ) as HTMLElement,
    );
    expect(stopped.getByText("Stopped")).toBeTruthy();
    expect(
      stopped.getByText(
        "You stopped this. Anything it had already done stays done.",
      ),
    ).toBeTruthy();
    expect(stopped.queryByText("Failed")).toBeNull();
    expect(stopped.queryByText(/Couldn't finish/)).toBeNull();
    expect(stopped.getByRole("button", { name: "Try again" })).toBeTruthy();
    // Its own choice, so it is not drawn as a failure: the card's stop icon, and no tint.
    const row = (title: string) =>
      surface.getByText(title).closest("[data-slot=item]") as HTMLElement;
    expect(row("Chase the supplier").dataset.taskState).toBe("stopped");
    expect(
      row("Chase the supplier").querySelector(".tabler-icon-player-stop"),
    ).not.toBeNull();
    expect(row("Chase the supplier").querySelector(".bg-amber-50")).toBeNull();
    expect(row("File the expense report").dataset.taskState).toBe("failed");
    expect(
      row("File the expense report").querySelector(".bg-amber-50"),
    ).not.toBeNull();

    // One that couldn't finish on its own still says so, in its card's words, and why.
    const failed = within(
      surface
        .getByText("File the expense report")
        .closest("[data-slot=item]") as HTMLElement,
    );
    expect(failed.getByText("Couldn't finish")).toBeTruthy();
    expect(failed.getByText("Gmail stopped answering.")).toBeTruthy();
    expect(failed.queryByText("Stopped")).toBeNull();
    expect(failed.getByRole("button", { name: "Try again" })).toBeTruthy();
  }
});

test("a task refused for good reads Couldn't finish, as its card does, and is offered no Try again", async () => {
  tasks = [
    task({
      id: "h",
      title: "Deals closing this week",
      origin: "delegated",
      status: "failed",
      failure: "Pipeline Bot isn't shared with you",
      failedAt: now,
      // Asking again gets the same answer, and the server says so.
      canTryAgain: false,
    }),
  ];
  waitingBots = [
    attentionOf("inbox", "Inbox Bot", {
      tasks: { needsInput: 0, ready: 0, failed: 1 },
    }),
  ];
  serving();
  const { region } = await drawAll();
  for (const name of ["Bots page", "Bot page"]) {
    const row = within(
      (await region(name).findByText("Deals closing this week")).closest(
        "[data-slot=item]",
      ) as HTMLElement,
    );
    // Its state in the card's words, and why once, as a sentence.
    expect(row.getByText("Couldn't finish")).toBeTruthy();
    expect(row.getByText("Pipeline Bot isn't shared with you.")).toBeTruthy();
    expect(row.queryByText("Failed")).toBeNull();
    // What can still be done with it: read it, or put it away.
    expect(row.queryByRole("button", { name: "Try again" })).toBeNull();
    expect(row.getByRole("button", { name: "Mark done" })).toBeTruthy();
    expect(row.getByRole("button", { name: "Open" }).getAttribute("href")).toBe(
      "/channel/c-h",
    );
  }
});

test("the board says a task's line as plain text, and a working task is not offered Mark done", async () => {
  tasks = [
    task({
      id: "t",
      title: "Check the river facts",
      next: "| Begins / headwaters | **Columbia Lake**, British Columbia |",
    }),
    task({
      id: "s",
      title: "Research the locks",
      next: "Source: Lake Washington Ship …",
    }),
    task({ id: "w", title: "Draft the board update", status: "working" }),
  ];
  serving();
  const { region } = await drawAll();
  for (const name of ["Bots page", "Bot page"]) {
    const surface = region(name);
    const row = async (title: string) =>
      (await surface.findByText(title)).closest(
        "[data-slot=item]",
      ) as HTMLElement;
    expect(
      within(await row("Check the river facts")).getByText(
        "Begins / headwaters: Columbia Lake, British Columbia",
      ),
    ).toBeTruthy();
    expect((await row("Research the locks")).textContent).not.toContain(
      "Source:",
    );
    const working = within(await row("Draft the board update"));
    expect(working.getByText("Open")).toBeTruthy();
    expect(working.queryByRole("button", { name: "Mark done" })).toBeNull();
    expect(
      within(await row("Check the river facts")).getByRole("button", {
        name: "Mark done",
      }),
    ).toBeTruthy();
  }
});

/*
 * A delegated task asked the person with the question tool. The question waits in the task's own
 * thread, and the server counts it once, as the task waiting on them. The board listed it twice, the
 * question and the task, under "2 waiting" beside a badge of 1.
 */
test("one wait inside a task is one row and one count, and rows that wait on nobody are not counted", async () => {
  const asked =
    "Which Fernhill seed packet should I order: tomato ($4.50) or basil ($3.25)?";
  tasks = [
    task({
      id: "q",
      title: "Order Fernhill seeds",
      origin: "delegated",
      status: "needs_input",
      next: `Waiting for your answer: ${asked}`,
    }),
    task({ id: "w", title: "Draft the board update", status: "working" }),
    task({
      id: "d",
      title: "Check the venue's doors time",
      origin: "delegated",
      next: "Doors open at 7:00 p.m.",
    }),
  ];
  questions = [
    {
      id: "question-q",
      botId: "inbox",
      threadId: "t-q",
      channelId: "c-q",
      question: asked,
      createdAt: now,
    },
  ];
  // As the server counts it: the task waiting on the person, not its question beside it.
  waitingBots = [
    attentionOf("inbox", "Inbox Bot", {
      tasks: { needsInput: 1, ready: 0, failed: 0 },
    }),
  ];
  serving();
  const { region } = await drawAll();
  for (const name of ["Bots page", "Bot page"]) {
    const surface = region(name);
    await surface.findByText("Order Fernhill seeds");
    expect(surface.getByText("1 waiting")).toBeTruthy();
    // The task stands for its question: no second row, and Answer is on the task's own row.
    expect(surface.queryByText(asked)).toBeNull();
    const row = (title: string) =>
      surface.getByText(title).closest("[data-slot=item]") as HTMLElement;
    expect(surface.getAllByRole("button", { name: "Answer" })).toHaveLength(1);
    expect(
      within(row("Order Fernhill seeds")).getByRole("button", {
        name: "Answer",
      }),
    ).toBeTruthy();
    expect(
      row("Order Fernhill seeds").querySelector(".bg-amber-50"),
    ).not.toBeNull();
    // Listed, and not waiting on the person: no tint. A finished delegated one is not listed.
    expect(
      row("Draft the board update").querySelector(".bg-amber-50"),
    ).toBeNull();
    expect(surface.queryByText("Check the venue's doors time")).toBeNull();
  }
  // The Bot's own badge on the Bots page says the same number.
  const bots = region("Bots page");
  const botRow = (await bots.findByText("1 task waiting on you")).closest(
    "[data-slot=item]",
  ) as HTMLElement;
  expect(within(botRow).getByText("1")).toBeTruthy();
  // Answered from the board, without opening the thread: the whole question, and a box to answer in.
  fireEvent.click(bots.getByRole("button", { name: "Answer" }));
  const dialog = await within(document.body).findByRole("dialog");
  expect(within(dialog).getByText(asked)).toBeTruthy();
  expect(
    within(dialog).getByRole("button", { name: "Send answer" }),
  ).toBeTruthy();
});

/*
 * FOUND IN THE BIG TEST: a task's card and its Activity row had Stop, and its row on the Needs you
 * board did not, though the design puts Stop on all three. A working task and one waiting on the
 * person (on a question in its thread, answered from the row) each offer Stop on the board, and
 * Stop is the same stop as the card's: the task is stopped and its row reads Stopped.
 */
test("a working task and a task waiting on the person each offer Stop on the board, and read Stopped once stopped", async () => {
  const asked = "Which region is the refund note for: EU, US or UK?";
  tasks = [
    task({
      id: "w",
      title: "Draft the EU refunds guide",
      origin: "delegated",
      status: "working",
    }),
    task({
      id: "q",
      title: "Draft a regional refund-policy note",
      origin: "delegated",
      status: "needs_input",
      next: `Waiting for your answer: ${asked}`,
    }),
  ];
  questions = [
    {
      id: "question-q",
      botId: "inbox",
      threadId: "t-q",
      channelId: "c-q",
      question: asked,
      createdAt: now,
    },
  ];
  waitingBots = [
    attentionOf("inbox", "Inbox Bot", {
      tasks: { needsInput: 1, ready: 0, failed: 0 },
    }),
  ];
  serving();
  const { region } = await drawAll();
  const surface = region("Bots page");
  const row = async (title: string) =>
    (await surface.findByText(title)).closest(
      "[data-slot=item]",
    ) as HTMLElement;
  for (const [title, id] of [
    ["Draft the EU refunds guide", "w"],
    ["Draft a regional refund-policy note", "q"],
  ] as const) {
    fireEvent.click(
      within(await row(title)).getByRole("button", { name: "Stop" }),
    );
    await waitFor(() =>
      expect(sent).toContainEqual({
        method: "POST",
        path: `${TASKS}/${id}/stop`,
      }),
    );
    await waitFor(async () =>
      expect(within(await row(title)).getByText("Stopped")).toBeTruthy(),
    );
    // Stopped, it is not offered Stop again.
    expect(
      within(await row(title)).queryByRole("button", { name: "Stop" }),
    ).toBeNull();
  }
});

/*
 * FOUND IN THE BIG TEST: the Bots badge said 16 and the board "18 waiting". The two were tasks under
 * a Bot no longer shared with the person ("This Bot isn't shared with you any more"), which the
 * server's count leaves out with every Bot they can't reach. The board says the badge's number, from
 * the same answer: such a task is still listed, to mark done, and is not counted.
 */
test("the board says the badge's count: a task under a Bot no longer shared is listed and not counted", async () => {
  tasks = [
    task({
      id: "q",
      title: "Order Fernhill seeds",
      origin: "delegated",
      status: "needs_input",
      next: "Waiting for your answer: tomato or basil?",
    }),
    task({
      id: "lost",
      agentId: "gone",
      title: "History of freight forwarding",
      origin: "delegated",
      status: "failed",
      failure: "this Bot isn't shared with you any more",
      failedAt: now,
      canTryAgain: false,
    }),
  ];
  // As the server answers: the Inbox Bot's task, and nothing for a Bot the person can't reach.
  waitingBots = [
    attentionOf("inbox", "Inbox Bot", {
      tasks: { needsInput: 1, ready: 0, failed: 0 },
    }),
  ];
  serving();
  const { region } = await drawAll();
  const surface = region("Bots page");
  await surface.findByText("History of freight forwarding");
  await surface.findByText("Order Fernhill seeds");
  await waitFor(() => expect(surface.getByText("1 waiting")).toBeTruthy());
  // Listed under its Bot, with Mark done, and nothing there waits on the person.
  const lost = surface
    .getByText("History of freight forwarding")
    .closest("[data-needs-you-bot]") as HTMLElement;
  expect(within(lost).getByText(/nothing waiting on you/)).toBeTruthy();
  expect(within(lost).getByRole("button", { name: "Mark done" })).toBeTruthy();
});

/*
 * A task waiting on an action in its thread is one row, the task's, and that row answers it: Allow
 * and Deny, the standing answers in its menu, why it asks and what it would send. Folded into the
 * task, the action's own buttons were gone and the person had to open the thread to answer.
 */
test("a task waiting on an approval is answered from its row on the board: Allow, Deny and the menu", async () => {
  tasks = [
    task({
      id: "a",
      title: "Order the basil seeds",
      origin: "delegated",
      status: "needs_input",
      next: "Waiting for your approval: click the button “Place order” on shop.example",
    }),
  ];
  requests = [
    {
      id: "r-a",
      action: {
        botId: "inbox",
        toolRef: "computer_click",
        effect: "write",
        scope: "shop.example",
        threadId: "t-a",
        args: { element: "Place order" },
        target: null,
        policy: {
          behaviour: "ask",
          source: "kind",
          reason: "Paying, buying or moving money asks you first.",
        },
      },
    },
  ];
  waitingBots = [
    attentionOf("inbox", "Inbox Bot", {
      tasks: { needsInput: 1, ready: 0, failed: 0 },
    }),
  ];
  serving();
  const { region } = await drawAll();
  const surface = region("Bots page");
  const row = (await surface.findByText("Order the basil seeds")).closest(
    "[data-slot=item]",
  ) as HTMLElement;
  expect(surface.getByText("1 waiting")).toBeTruthy();
  expect(
    within(row).getByText("Paying, buying or moving money asks you first."),
  ).toBeTruthy();
  expect(within(row).getByRole("button", { name: "Allow" })).toBeTruthy();
  expect(within(row).getByRole("button", { name: /^More for / })).toBeTruthy();
  fireEvent.click(within(row).getByRole("button", { name: "Deny" }));
  await waitFor(() =>
    expect(sent).toContainEqual({
      method: "POST",
      path: `${APPROVALS_PATH}/r-a/decide`,
    }),
  );
});

/*
 * The badge counts a hand-off that ran out of tries; the board listed none, so its number and its
 * rows could disagree. It is a row of its own, under the Bot that asked for it, and counted once.
 */
test("a stalled hand-off is a row on the board and in its count, as in the badge", async () => {
  stalled = [
    {
      id: "hop-stalled",
      kind: "handoff",
      title: "Book the venue for Friday",
      detail: "Delegated to Ops Bot",
      status: "failed",
      at: now,
      channelId: "c-hop",
      needsYou: true,
      stoppable: false,
      cancellable: false,
    },
  ];
  waitingBots = [attentionOf("inbox", "Inbox Bot", { handoffs: 1 })];
  serving();
  const { region } = await drawAll();
  for (const name of ["Bots page", "Bot page"]) {
    const surface = region(name);
    const row = (await surface.findByText("Book the venue for Friday")).closest(
      "[data-slot=item]",
    ) as HTMLElement;
    expect(within(row).getByText("Stalled hand-off")).toBeTruthy();
    expect(within(row).getByText("Open")).toBeTruthy();
    expect(surface.getByText("1 waiting")).toBeTruthy();
  }
  // The roster's own count for the Bot says the same.
  expect(
    await region("Bots page").findByText("1 stalled hand-off"),
  ).toBeTruthy();
});

test("a board with nothing waiting on the person never says it is waiting", async () => {
  tasks = [
    task({ id: "w", title: "Draft the board update", status: "working" }),
    task({
      id: "d",
      title: "Check the venue's doors time",
      origin: "delegated",
      next: "Doors open at 7:00 p.m.",
    }),
  ];
  serving();
  const { region } = await drawAll();
  for (const name of ["Bots page", "Bot page"]) {
    const surface = region(name);
    await surface.findByText("Draft the board update");
    expect(surface.queryByText("Check the venue's doors time")).toBeNull();
    expect(surface.getByText("Your tasks")).toBeTruthy();
    expect(surface.queryByText("Waiting on you")).toBeNull();
    expect(surface.queryByText(/\d+ waiting/)).toBeNull();
    expect(surface.getByText(/nothing waiting on you/)).toBeTruthy();
    expect(surface.queryByText(/waiting since/)).toBeNull();
  }
});

/*
 * A delegated task that has finished waits on nobody: its result line is already in the conversation
 * that asked for it, and it is listed on its Bot's Activity page under Done. So it leaves every list
 * of what needs the person, the board on the Bots page and on the Bot's page, OpenDuet's Tasks and
 * OpenFuse's bell, and they all agree. One that still waits on the person stays on each.
 */
test("a finished delegated task leaves the board, OpenDuet's Tasks and the bell; one still waiting stays", async () => {
  tasks = [
    task({
      id: "q",
      title: "Order Fernhill seeds",
      origin: "delegated",
      status: "needs_input",
      next: "Waiting for your answer: tomato or basil?",
    }),
    task({
      id: "d",
      title: "Check the venue's doors time",
      origin: "delegated",
      next: "Doors open at 7:00 p.m.",
    }),
  ];
  waitingBots = [
    attentionOf("inbox", "Inbox Bot", {
      tasks: { needsInput: 1, ready: 0, failed: 0 },
    }),
  ];
  serving();
  const { region, view } = await drawAll("active");
  for (const name of ["Bots page", "Bot page", "OpenDuet"]) {
    const surface = region(name);
    await surface.findByText("Order Fernhill seeds");
    expect(surface.queryByText("Check the venue's doors time")).toBeNull();
    expect(surface.queryByText("Doors open at 7:00 p.m.")).toBeNull();
  }
  // OpenDuet has no Ready for review group for it to sit under either.
  expect(
    region("OpenDuet").queryByRole("region", { name: "Ready for review" }),
  ).toBeNull();
  view.unmount();
  const bell = await drawBell();
  await bell.findByText("Order Fernhill seeds");
  expect(bell.queryByText("Check the venue's doors time")).toBeNull();
});

/*
 * A Bot whose only task has finished has nothing waiting on the person: its page draws no board, as
 * when nothing ever waited, and the bell says the person is all caught up.
 */
test("a Bot whose only task has finished has nothing on the board", async () => {
  tasks = [
    task({
      id: "d",
      title: "Check the venue's doors time",
      origin: "delegated",
      next: "Doors open at 7:00 p.m.",
    }),
  ];
  serving();
  const { region, view } = await drawAll("active");
  // Looked at once the tasks have loaded, so nothing is missing only because it is still coming.
  await waitFor(() =>
    expect(queryClient.getQueryState(taskKeys.list)?.status).toBe("success"),
  );
  for (const name of ["Bots page", "Bot page", "OpenDuet"]) {
    const surface = region(name);
    expect(surface.queryByText("Check the venue's doors time")).toBeNull();
    expect(surface.queryByRole("heading", { name: "Needs you" })).toBeNull();
  }
  view.unmount();
  const bell = await drawBell();
  expect(await bell.findByText("You're all caught up")).toBeTruthy();
  expect(bell.queryByText("Check the venue's doors time")).toBeNull();
});

test("a task whose conversation is running a turn reads Working, whatever the server last said", async () => {
  tasks = [task({ id: "r", title: "Reply to the landlord" })];
  busy = ["c-r"];
  serving();
  const { region } = await drawAll();
  const bots = region("Bots page");
  await waitFor(() => expect(bots.getByText("Working")).toBeTruthy());
});

test("OpenDuet's Active lists the tasks under OpenDuet's headings, in its order", async () => {
  window.localStorage.setItem(TASKS_VIEW_STORAGE_KEY, "active");
  tasks = [
    task({ id: "w", title: "Draft the board update", status: "working" }),
    task({ id: "r", title: "Reply to the landlord" }),
  ];
  serving();
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const rootRoute = createRootRoute({ component: TasksScreen });
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      createRoute({
        getParentRoute: () => rootRoute,
        path: "/channel/$channelId",
        component: () => null,
      }),
    ]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  const view = render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
  const ready = await view.findByRole("region", { name: "Ready for review" });
  expect(within(ready).getByText("Reply to the landlord")).toBeTruthy();
  const working = view.getByRole("region", { name: "Working" });
  expect(within(working).getByText("Draft the board update")).toBeTruthy();
  const order = [...view.container.querySelectorAll("section[aria-label]")].map(
    (section) => section.getAttribute("aria-label"),
  );
  expect(order.indexOf("Ready for review")).toBeLessThan(
    order.indexOf("Working"),
  );
});

/*
 * A board drawn from three reads: questions and approvals, tasks, and check-in findings. One failing
 * must not hide what the others loaded, and must not read as "nothing waiting".
 */
const APPROVALS = APPROVALS_PATH;
// The fake reads a list in the API by its address, without the `limit` it is asked for with.
const TASKS = TASKS_PATH;
const CHECK_INS = CHECK_IN_ITEMS_PATH;

async function botPage() {
  const { region } = await drawAll();
  return region("Bot page");
}

const notice = (page: ReturnType<typeof within>, what: string) =>
  page.queryByText(`Couldn't load ${what}. Some may be missing here.`);

test("approvals failing leaves the check-in findings on the board, with a notice and Retry", async () => {
  items = [item({ id: "i1", title: "Reply to Dana" })];
  failing = new Set([APPROVALS]);
  serving();
  const page = await botPage();
  await page.findByText("Reply to Dana");
  await waitFor(
    () => expect(notice(page, "questions and approvals")).not.toBeNull(),
    { timeout: 3000 },
  );
  expect(notice(page, "tasks")).toBeNull();
  expect(notice(page, "check-in findings")).toBeNull();
});

test("check-ins failing leaves the questions on the board, with a notice", async () => {
  questions = [
    {
      id: "q1",
      botId: "inbox",
      threadId: "thread",
      question: "Which folder?",
      createdAt: now,
    },
  ];
  failing = new Set([CHECK_INS]);
  serving();
  const page = await botPage();
  await page.findByText(/Which folder\?/);
  await waitFor(
    () => expect(notice(page, "check-in findings")).not.toBeNull(),
    { timeout: 3000 },
  );
  expect(notice(page, "questions and approvals")).toBeNull();
});

test("tasks alone failing says so, and says nothing about the rest", async () => {
  items = [item({ id: "i1", title: "Reply to Dana" })];
  failing = new Set([TASKS]);
  serving();
  const page = await botPage();
  await page.findByText("Reply to Dana");
  await waitFor(() => expect(notice(page, "tasks")).not.toBeNull(), {
    timeout: 3000,
  });
  expect(notice(page, "questions and approvals")).toBeNull();
  expect(notice(page, "check-in findings")).toBeNull();
});

test("everything failing shows each notice, and never an empty board", async () => {
  failing = new Set([APPROVALS, TASKS, CHECK_INS]);
  serving();
  const page = await botPage();
  await waitFor(
    () => {
      expect(notice(page, "questions and approvals")).not.toBeNull();
      expect(notice(page, "tasks")).not.toBeNull();
      expect(notice(page, "check-in findings")).not.toBeNull();
    },
    { timeout: 3000 },
  );
  expect(page.getByText("Needs you")).toBeDefined();
});

test("Retry asks again, keeps what loaded, and the notice clears once it answers", async () => {
  items = [item({ id: "i1", title: "Reply to Dana" })];
  questions = [
    {
      id: "q1",
      botId: "inbox",
      threadId: "thread",
      question: "Which folder?",
      createdAt: now,
    },
  ];
  failing = new Set([APPROVALS]);
  serving();
  const page = await botPage();
  await waitFor(
    () => expect(notice(page, "questions and approvals")).not.toBeNull(),
    { timeout: 3000 },
  );
  expect(page.queryByText(/Which folder\?/)).toBeNull();

  failing = new Set();
  const alert = page.getByText(
    "Couldn't load questions and approvals. Some may be missing here.",
  ).parentElement as HTMLElement;
  fireEvent.click(within(alert).getByRole("button", { name: "Retry" }));

  await page.findByText(/Which folder\?/);
  await waitFor(() =>
    expect(notice(page, "questions and approvals")).toBeNull(),
  );
  expect(page.getByText("Reply to Dana")).toBeDefined();
});

test("a refetch that fails after a good read keeps the rows and adds the notice", async () => {
  items = [item({ id: "i1", title: "Reply to Dana" })];
  serving();
  const page = await botPage();
  await page.findByText("Reply to Dana");

  failing = new Set([CHECK_INS]);
  await queryClient.refetchQueries({ queryKey: ["proactive"] }).catch(() => {});

  await waitFor(
    () => expect(notice(page, "check-in findings")).not.toBeNull(),
    { timeout: 3000 },
  );
  expect(page.getByText("Reply to Dana")).toBeDefined();
});
