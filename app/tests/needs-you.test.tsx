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
import { queryClient } from "@/query-client";
import {
  TASKS_VIEW_STORAGE_KEY,
  TasksScreen,
} from "@/skins/openduet/tasks-screen";
import { APPROVALS_PATH, approvalInboxResponse } from "./approvals-api";
import { answerBotAttention, answerBotsList } from "./bots-api";
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
  origin: "check_in";
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
  question: string;
  createdAt: string;
}[] = [];
/** Reads that fail right now, by path, to test a board drawn from some sources and not others. */
let failing = new Set<string>();
/** Conversations a turn is running in right now, as the sidebar's live list says. */
let busy: string[] = [];
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
      /^\/api\/v2\/organizations\/default\/tasks\/(.+)\/(resolve|reopen|retry)$/,
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
        requests: [],
        questions,
      });
      if (approvals) return approvals;
    }
    const waiting = answerBotAttention(input, init, { bots: [] });
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
  // Work on it, Dismiss and a task's actions invalidate the app's one cache, so the lists draw from it.
  queryClient.clear();
});

/** The Bots page, the Inbox Bot's page and OpenDuet's Tasks on its Up next list, side by side. */
async function drawAll() {
  window.localStorage.setItem(TASKS_VIEW_STORAGE_KEY, "up_next");
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
  expect(
    bots.getByText("Couldn't finish: Gmail stopped answering."),
  ).toBeTruthy();

  fireEvent.click(bots.getByRole("button", { name: "Try again" }));
  await waitFor(() =>
    expect(sent).toContainEqual({
      method: "POST",
      path: "/api/v2/organizations/default/tasks/f/retry",
    }),
  );
  await waitFor(() =>
    expect(
      bots.queryByText("Couldn't finish: Gmail stopped answering."),
    ).toBeNull(),
  );

  const ready = bots
    .getByText("Reply to the landlord")
    .closest("[data-slot=item]") as HTMLElement;
  fireEvent.click(within(ready).getByRole("button", { name: "Mark done" }));
  // Marked done, it leaves Needs you for the folded Done list, where it can be reopened.
  const done = await bots.findByRole("heading", { name: "Done" });
  const section = within(done.closest("section") as HTMLElement);
  expect(section.getByText("1 task you marked done this week.")).toBeTruthy();
  fireEvent.click(section.getByRole("button", { name: "Show" }));
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
  serving();
  const { region } = await drawAll();
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

    // One that couldn't finish on its own still says so.
    const failed = within(
      surface
        .getByText("File the expense report")
        .closest("[data-slot=item]") as HTMLElement,
    );
    expect(failed.getByText("Failed")).toBeTruthy();
    expect(
      failed.getByText("Couldn't finish: Gmail stopped answering."),
    ).toBeTruthy();
    expect(failed.queryByText("Stopped")).toBeNull();
    expect(failed.getByRole("button", { name: "Try again" })).toBeTruthy();
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
