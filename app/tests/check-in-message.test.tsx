import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import type { Message } from "@ag-ui/core";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { checkInMessage } from "@openbot/shared/check-in-message";
import { QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import {
  cleanup,
  fireEvent,
  render,
  waitFor,
  within,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { ChatTranscript } from "@/components/channels/chat-transcript";
import {
  CheckInItems,
  CheckInRan,
  clockTime,
} from "@/components/channels/check-in-message";
import { BotNeedsYou } from "@/components/needs-you/board";
import { queryClient } from "@/query-client";
import { approvalInboxResponse } from "./approvals-api";
import { answerBotsList } from "./bots-api";
import { CONVERSATIONS_PATH, TASKS_PATH, taskPath } from "./conversations-api";
import { CHECK_IN_ITEMS_PATH, CHECK_INS_PATH, pathOf } from "./schedules-api";
import { settleReactWork } from "./settle-react-work";

/**
 * A check-in that found something, saying so in its conversation: the line that says it ran, the
 * Bot's sentence, and a card for each thing it raised.
 *
 * The cards are the Needs you board's rows on a card, so what is held here is that they say what is
 * true NOW (open, started, or no longer open), and that an item answered in the conversation and
 * one answered on the board are the same write, read back from the same list.
 *
 * The server is faked at `fetch` only, answering where the API answers. The app's own query client
 * is the one mounted, because Work on it and dismiss refresh that one.
 */

beforeAll(() => GlobalRegistrator.register({ url: "http://localhost/" }));
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

const item = (id: string, title: string, more: object = {}) => ({
  id,
  botId: "general-assistant",
  checkInId: "chk_inbox",
  status: "open" as const,
  title,
  detail:
    "She asked if 2:00 PM still works and is holding the room until noon.",
  sourceApp: "Gmail",
  sourceRef: null,
  sourceLink: "https://mail.google.com/mail/u/0/#inbox/18c2",
  pingId: null,
  deliveredAt: null,
  resolvedAt: null,
  createdAt: "2026-11-17T16:00:00.000Z",
  ...more,
});

const taskFrom = (suggestionId: string, title: string) => ({
  id: `task-${suggestionId}`,
  botId: "general-assistant",
  conversationId: `channel-${suggestionId}`,
  threadId: `thread-${suggestionId}`,
  title,
  why: null,
  origin: "check_in",
  suggestionId,
  sourceApp: "Gmail",
  sourceLink: null,
  originConversationId: null,
  agent: null,
  status: "working",
  failure: null,
  failedAt: null,
  stoppedAt: null,
  workingSince: "2026-11-17T16:05:00.000Z",
  tryingAgainAt: null,
  lastActivityAt: "2026-11-17T16:05:00.000Z",
  next: null,
  resolvedAt: null,
  createdAt: "2026-11-17T16:05:00.000Z",
  updatedAt: "2026-11-17T16:05:00.000Z",
});

const ROSA = "Reply to Rosa about Thursday's vendor review";
const NORTHWIND = "Sign the Northwind renewal before Friday";

/** What the faked server holds. A write changes it, as the server's own would. */
let open: ReturnType<typeof item>[] = [];
let tasks: ReturnType<typeof taskFrom>[] = [];
let checkIns: object[] = [];
/** Held shut, the task list is not answered until the test lets it go. */
let tasksGate: Promise<void> | null = null;
/** While true, the task list is answered with a failure. */
let tasksDown = false;
/** Every write, with the key it was sent with. */
const sent: { method: string; path: string; key: string | null }[] = [];
/** Every read, by the address it asked. */
const read: string[] = [];
const readsOf = (path: string) => read.filter((each) => each === path).length;

afterEach(() => {
  open = [];
  tasks = [];
  checkIns = [];
  tasksGate = null;
  tasksDown = false;
  sent.length = 0;
  read.length = 0;
});

function serving() {
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = pathOf(input);
    const method = (init?.method ?? "GET").toUpperCase();
    if (method !== "GET") {
      sent.push({
        method,
        path,
        key: new Headers(init?.headers).get("Idempotency-Key"),
      });
      const [, id, action] =
        path.match(/\/check-in-items\/([^/]+)\/(start|dismiss)$/) ?? [];
      const found = open.find((each) => each.id === id);
      if (!found || !action) return Response.json({}, { status: 404 });
      open = open.filter((each) => each !== found);
      if (action === "dismiss")
        return Response.json({
          checkInItem: { ...found, status: "dismissed" },
        });
      const task = taskFrom(found.id, found.title);
      tasks = [...tasks, task];
      return Response.json({
        checkInItem: { ...found, status: "started" },
        task: { id: task.id, conversationId: task.conversationId },
      });
    }
    read.push(path);
    if (path === CHECK_IN_ITEMS_PATH)
      return Response.json({ checkInItems: open, nextCursor: null });
    if (path === CHECK_INS_PATH)
      return Response.json({ checkIns, allowed: true, nextCursor: null });
    if (path === TASKS_PATH) {
      if (tasksGate) await tasksGate;
      if (tasksDown) return Response.json({}, { status: 500 });
      return Response.json({ tasks, nextCursor: null });
    }
    const one = tasks.find((task) => path === taskPath(task.id));
    if (one) return Response.json({ task: one });
    if (path === CONVERSATIONS_PATH)
      return Response.json({ conversations: [], nextCursor: null });
    return (
      approvalInboxResponse(input, {}) ??
      answerBotsList(input, init, {
        visible: [{ id: "general-assistant", name: "General Assistant" }],
      }) ??
      Response.json({})
    );
  }) as unknown as typeof fetch;
}

/** In a router, because a started item's task card links into its thread. */
function mount(children: ReactNode) {
  const root = createRootRoute({ component: Outlet });
  const router = createRouter({
    routeTree: root.addChildren([
      createRoute({
        getParentRoute: () => root,
        path: "/",
        component: () => <>{children}</>,
      }),
      createRoute({
        getParentRoute: () => root,
        path: "/channel/$channelId",
        component: () => null,
      }),
    ]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

/** One item's place among the cards, once it is drawn in the state asked for. */
const drawnAs = (
  view: ReturnType<typeof mount>,
  id: string,
  state: "open" | "started" | "closed",
) =>
  waitFor(() => {
    const found = view.container.querySelector(
      `[data-check-in-item="${id}"][data-state="${state}"]`,
    );
    if (!found) throw new Error(`${id} is not drawn as ${state}`);
    return found as HTMLElement;
  });

test("an open item is the board's row on a card: what it is, why, where from, and both answers", async () => {
  open = [item("itm_rosa", ROSA)];
  serving();
  const view = mount(<CheckInItems itemIds={["itm_rosa"]} />);
  const card = await drawnAs(view, "itm_rosa", "open");
  expect(within(card).getByText(ROSA)).toBeTruthy();
  // Why it was raised is read in full here, as part of what the Bot is saying.
  expect(
    within(card).getByText(/She asked if 2:00 PM still works/).className,
  ).toContain("line-clamp-none");
  expect(within(card).getByText("Gmail")).toBeTruthy();
  expect(
    within(card).getByRole("link", { name: /Open mail\.google\.com/ }),
  ).toBeTruthy();
  expect(within(card).getByRole("button", { name: "Work on it" })).toBeTruthy();
  expect(
    within(card).getByRole("button", { name: `Dismiss ${ROSA}` }),
  ).toBeTruthy();
  // The Bot and the time are the message's to say, above the cards.
  expect(card.textContent).not.toContain("General Assistant");
  expect(card.querySelector("time")).toBeNull();
});

test("a started item is the task it became, with no Work on it left to press", async () => {
  tasks = [taskFrom("itm_rosa", ROSA)];
  serving();
  const view = mount(<CheckInItems itemIds={["itm_rosa"]} />);
  const card = await drawnAs(view, "itm_rosa", "started");
  const task = within(card).getByRole("region", { name: `Task: ${ROSA}` });
  expect(task.getAttribute("data-slot")).toBe("task-card");
  // The way into the task's own conversation, as every task card has it.
  expect(
    within(card)
      .getByRole("button", { name: /Open thread/ })
      .getAttribute("href"),
  ).toBe("/channel/channel-itm_rosa");
  expect(view.queryByRole("button", { name: "Work on it" })).toBeNull();
});

test("an item that is no longer open, and became no task, is one muted line", async () => {
  // Dismissed elsewhere, cleared by a later check-in, or never this person's: the API lists open
  // items only, so all three read the same and the line names none of them.
  open = [item("itm_northwind", NORTHWIND)];
  serving();
  const view = mount(<CheckInItems itemIds={["itm_gone", "itm_northwind"]} />);
  const line = await drawnAs(view, "itm_gone", "closed");
  expect(line.textContent).toBe("1 item no longer needs you.");
  expect(line.className).toContain("text-muted-foreground");
  // The one beside it is untouched.
  await drawnAs(view, "itm_northwind", "open");
});

test("items in a row that are no longer open share one line", async () => {
  serving();
  const view = mount(<CheckInItems itemIds={["itm_a", "itm_b"]} />);
  const line = await drawnAs(view, "itm_a", "closed");
  expect(line.textContent).toBe("2 items no longer need you.");
  expect(view.container.querySelectorAll("[data-check-in-item]")).toHaveLength(
    1,
  );
});

test("nothing is drawn until both lists are read", async () => {
  open = [item("itm_rosa", ROSA)];
  let letGo = () => {};
  tasksGate = new Promise((resolve) => {
    letGo = resolve;
  });
  serving();
  const view = mount(<CheckInItems itemIds={["itm_rosa", "itm_gone"]} />);
  // The open items are in, the tasks are not: an item is not called closed on half an answer.
  await waitFor(() =>
    expect(queryClient.getQueryData(["proactive", "suggestions"])).toBeTruthy(),
  );
  expect(view.container.querySelector("[data-check-in-item]")).toBeNull();
  letGo();
  await drawnAs(view, "itm_rosa", "open");
  await drawnAs(view, "itm_gone", "closed");
});

test("dismissed here: the card collapses to the line, by the board's own request", async () => {
  open = [item("itm_rosa", ROSA), item("itm_northwind", NORTHWIND)];
  serving();
  const view = mount(<CheckInItems itemIds={["itm_rosa", "itm_northwind"]} />);
  const card = await drawnAs(view, "itm_rosa", "open");
  fireEvent.click(
    within(card).getByRole("button", { name: `Dismiss ${ROSA}` }),
  );
  const line = await drawnAs(view, "itm_rosa", "closed");
  expect(line.textContent).toBe("1 item no longer needs you.");
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({
    method: "POST",
    path: `${CHECK_IN_ITEMS_PATH}/itm_rosa/dismiss`,
  });
  expect(sent[0]?.key).toBeTruthy();
  await drawnAs(view, "itm_northwind", "open");
});

test("Work on it here: the card becomes its task, and is never called closed on the way", async () => {
  open = [item("itm_rosa", ROSA)];
  serving();
  const view = mount(<CheckInItems itemIds={["itm_rosa"]} />);
  const card = await drawnAs(view, "itm_rosa", "open");
  // From here the open items come back before the tasks do, so the item is on neither list.
  let letGo = () => {};
  tasksGate = new Promise((resolve) => {
    letGo = resolve;
  });
  fireEvent.click(within(card).getByRole("button", { name: "Work on it" }));
  await waitFor(() =>
    expect(view.container.querySelector('[data-state="open"]')).toBeNull(),
  );
  expect(view.container.querySelector('[data-state="closed"]')).toBeNull();
  expect(view.container.textContent).not.toContain("no longer need");
  letGo();
  const started = await drawnAs(view, "itm_rosa", "started");
  expect(
    within(started).getByRole("region", { name: `Task: ${ROSA}` }),
  ).toBeTruthy();
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({
    method: "POST",
    path: `${CHECK_IN_ITEMS_PATH}/itm_rosa/start`,
  });
  expect(sent[0]?.key).toBeTruthy();
});

/** The open items' own timer coming round, as it does every half minute. */
const openItemsReadAgain = () =>
  queryClient.invalidateQueries({ queryKey: ["proactive", "suggestions"] });

test("started in another window: the tasks are read at once, and it is never called closed meanwhile", async () => {
  open = [item("itm_rosa", ROSA)];
  serving();
  const view = mount(<CheckInItems itemIds={["itm_rosa"]} />);
  await drawnAs(view, "itm_rosa", "open");
  // Work on it, pressed somewhere else: the server has the task, and this window sent nothing.
  tasks = [taskFrom("itm_rosa", ROSA)];
  open = [];
  let letGo = () => {};
  tasksGate = new Promise((resolve) => {
    letGo = resolve;
  });
  const before = readsOf(TASKS_PATH);
  await openItemsReadAgain();
  await waitFor(() =>
    expect(view.container.querySelector('[data-state="open"]')).toBeNull(),
  );
  // On neither list as this window has them, which is what closed looks like. It is not said.
  expect(view.container.querySelector('[data-state="closed"]')).toBeNull();
  // And the tasks are not waited for on their timer: they are asked for now.
  await waitFor(() => expect(readsOf(TASKS_PATH)).toBe(before + 1));
  letGo();
  await drawnAs(view, "itm_rosa", "started");
  expect(sent).toHaveLength(0);
});

test("cleared while it was on screen: closed, once the tasks read after it say it became none", async () => {
  open = [item("itm_rosa", ROSA)];
  serving();
  const view = mount(<CheckInItems itemIds={["itm_rosa"]} />);
  await drawnAs(view, "itm_rosa", "open");
  // A later check-in cleared it as no longer needed.
  open = [];
  const before = readsOf(TASKS_PATH);
  await openItemsReadAgain();
  const line = await drawnAs(view, "itm_rosa", "closed");
  expect(line.textContent).toBe("1 item no longer needs you.");
  expect(readsOf(TASKS_PATH)).toBe(before + 1);
});

test("tasks that cannot be read are not asked for in a loop, and nothing is called closed", async () => {
  open = [item("itm_rosa", ROSA)];
  serving();
  const view = mount(<CheckInItems itemIds={["itm_rosa"]} />);
  await drawnAs(view, "itm_rosa", "open");
  open = [];
  tasksDown = true;
  const before = readsOf(TASKS_PATH);
  await openItemsReadAgain();
  await waitFor(() =>
    expect(view.container.querySelector('[data-state="open"]')).toBeNull(),
  );
  // Long enough for the one read, and the one retry every read in the app gets, to have failed.
  await new Promise((resolve) => setTimeout(resolve, 1600));
  expect(readsOf(TASKS_PATH) - before).toBeLessThanOrEqual(2);
  expect(view.container.querySelector('[data-state="closed"]')).toBeNull();
});

test("the board and the conversation are one list: answered in either, it changes in both", async () => {
  open = [item("itm_rosa", ROSA), item("itm_northwind", NORTHWIND)];
  serving();
  const view = mount(
    <>
      <section data-testid="board">
        <BotNeedsYou agentId="general-assistant" />
      </section>
      <section data-testid="conversation">
        <CheckInItems itemIds={["itm_rosa", "itm_northwind"]} />
      </section>
    </>,
  );
  const board = within(await view.findByTestId("board"));
  const conversation = view.getByTestId("conversation");
  await board.findByText(ROSA);
  await board.findByText(NORTHWIND);
  await drawnAs(view, "itm_rosa", "open");

  // Dismissed in the conversation: gone from the board.
  fireEvent.click(
    within(conversation).getByRole("button", { name: `Dismiss ${ROSA}` }),
  );
  await waitFor(() => expect(board.queryByText(ROSA)).toBeNull());
  await drawnAs(view, "itm_rosa", "closed");

  // Started on the board: its task card in the conversation.
  fireEvent.click(board.getByRole("button", { name: "Work on it" }));
  await drawnAs(view, "itm_northwind", "started");

  // The same two requests the board alone would have sent, each once, each with a key of its own.
  expect(sent.map(({ method, path }) => `${method} ${path}`)).toEqual([
    `POST ${CHECK_IN_ITEMS_PATH}/itm_rosa/dismiss`,
    `POST ${CHECK_IN_ITEMS_PATH}/itm_northwind/start`,
  ]);
  expect(new Set(sent.map(({ key }) => key)).size).toBe(2);
});

test("the line says a check-in ran, what it watches now, and when", async () => {
  checkIns = [{ id: "chk_inbox", subject: "Your inbox" }];
  serving();
  const view = mount(
    <CheckInRan checkInId="chk_inbox" ranAt="2026-11-17T16:00:00.000Z" />,
  );
  await view.findByText(/Your inbox,/);
  const line = view.container.querySelector("[data-check-in-ran]");
  expect(line?.textContent).toStartWith("Check-in ran. Your inbox, ");
  expect(line?.className).toContain("text-muted-foreground");
  expect(line?.querySelector("time")?.getAttribute("dateTime")).toBe(
    "2026-11-17T16:00:00.000Z",
  );
});

test("a check-in removed since still says when it ran", async () => {
  serving();
  const view = mount(
    <CheckInRan checkInId="chk_gone" ranAt="2026-11-17T16:00:00.000Z" />,
  );
  await waitFor(() =>
    expect(queryClient.getQueryData(["proactive", "settings"])).toBeTruthy(),
  );
  const line = view.container.querySelector("[data-check-in-ran]");
  expect(line?.textContent).toStartWith("Check-in ran. ");
  expect(line?.textContent).toBe(
    `Check-in ran. ${line?.querySelector("time")?.textContent}`,
  );
});

test("the time is the clock's alone for today, and carries its day once it is not", () => {
  const now = new Date(2026, 10, 17, 9, 30);
  const today = new Date(2026, 10, 17, 8, 0);
  const time = today.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
  expect(clockTime(today, now)).toBe(time);
  const friday = clockTime(new Date(2026, 10, 13, 8, 0), now);
  expect(friday).toEndWith(`, ${time}`);
  expect(friday).toContain("13");
  expect(friday).not.toContain("2026");
  expect(clockTime(new Date(2025, 10, 13, 8, 0), now)).toContain("2025");
});

function assistant(id: string, text: string): Message {
  return { id, role: "assistant", content: text };
}

const said = {
  checkInId: "chk_inbox",
  ranAt: "2026-11-17T16:00:00.000Z",
  itemIds: ["itm_rosa", "itm_northwind"],
  message: "Good morning. Two emails need you today.",
};

test("in a transcript: the line, the Bot's sentence and the cards, and none of the marker", async () => {
  open = [item("itm_rosa", ROSA), item("itm_northwind", NORTHWIND)];
  checkIns = [{ id: "chk_inbox", subject: "Your inbox" }];
  serving();
  const view = mount(
    <ChatTranscript
      messages={[assistant("a1", checkInMessage(said))]}
      restoring={false}
    />,
  );
  await drawnAs(view, "itm_rosa", "open");
  await drawnAs(view, "itm_northwind", "open");
  const message = view.container.querySelector("[data-check-in]");
  // In the order a person would say it.
  const text = message?.textContent ?? "";
  expect(text.indexOf("Check-in ran.")).toBe(0);
  expect(text.indexOf(said.message)).toBeGreaterThan(0);
  expect(text.indexOf(ROSA)).toBeGreaterThan(text.indexOf(said.message));
  expect(view.container.textContent).not.toContain("[check-in]");
  expect(view.container.textContent).not.toContain("chk_inbox");
  expect(view.container.textContent).not.toContain("itemIds");
});

test("in a transcript: a marker that does not read is drawn as the Bot wrote it", async () => {
  serving();
  const broken = '[check-in]{"checkInId":"chk_inbox"} Good morning.';
  const view = mount(
    <ChatTranscript messages={[assistant("a1", broken)]} restoring={false} />,
  );
  await waitFor(() =>
    expect(view.container.textContent).toContain("Good morning."),
  );
  expect(view.container.querySelector("[data-check-in]")).toBeNull();
});

test("in a transcript: one still being written is held back until its marker is all here", async () => {
  open = [item("itm_rosa", ROSA), item("itm_northwind", NORTHWIND)];
  serving();
  const whole = checkInMessage(said);
  const transcript = (text: string, busy: boolean) => (
    <QueryClientProvider client={queryClient}>
      <ChatTranscript
        busy={busy}
        messages={[assistant("a1", text)]}
        restoring={false}
      />
    </QueryClientProvider>
  );
  const view = render(transcript(whole.slice(0, 24), true));
  expect(view.container.textContent).not.toContain("[check-in]");
  expect(view.container.querySelector("[data-check-in]")).toBeNull();
  view.rerender(transcript(whole, false));
  await waitFor(() =>
    expect(view.container.querySelector("[data-check-in]")).toBeTruthy(),
  );
  expect(view.container.textContent).toContain(said.message);
  expect(view.container.textContent).not.toContain("[check-in]");
});
