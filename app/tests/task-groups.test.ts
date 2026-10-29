import { afterEach, expect, test } from "bun:test";
import { MutationObserver, QueryClient } from "@tanstack/react-query";
import {
  type ApprovalRequest,
  answerPersonQuestionMutationOptions,
  decideApprovalMutationOptions,
  type PersonQuestion,
} from "@/lib/approvals";
import {
  GROUP_ORDER,
  needsYouCount,
  taskGroups,
  taskItem,
} from "@/lib/tasks/groups";
import {
  couldNotFinish,
  type TaskRecord,
  type TaskStatus,
  taskKeys,
  taskListQueryOptions,
  taskQueryOptions,
  taskReportQueryOptions,
} from "@/lib/tasks/queries";

/**
 * How Tasks' list is grouped, ordered and counted, worked out without drawing anything: the order
 * of the groups, a task's own approval or question making it Needs you, the line under each title,
 * and the sidebar's count being exactly the Needs you group. How often tasks are read again.
 */

const NOW = Date.parse("2026-10-28T12:00:00Z");
const at = (minutesAgo: number) =>
  new Date(NOW - minutesAgo * 60_000).toISOString();

const task = (overrides: Partial<TaskRecord> & { id: string }): TaskRecord => ({
  botId: "scout",
  channelId: `${overrides.id}-channel`,
  threadId: `${overrides.id}-thread`,
  title: overrides.id,
  why: null,
  origin: "asked",
  suggestionId: null,
  sourceApp: null,
  sourceLink: null,
  failure: null,
  failedAt: null,
  next: null,
  queuedReplies: [],
  answeredQuestionIds: [],
  status: "working",
  resolvedAt: null,
  createdAt: at(60),
  updatedAt: at(60),
  ...overrides,
});

const request = (
  id: string,
  threadId: string,
  status = "pending",
): ApprovalRequest => ({
  id,
  status,
  createdAt: at(5),
  action: {
    botId: "scout",
    toolRef: "mcp/gmail/send_email",
    effect: "write",
    scope: "ana@example.com",
    threadId,
    args: {},
    target: {},
  },
});

const question = (id: string, threadId: string): PersonQuestion => ({
  id,
  botId: "scout",
  threadId,
  question: "Which deck?",
  createdAt: at(3),
});

const inbox = (
  requests: ApprovalRequest[] = [],
  questions: PersonQuestion[] = [],
) => ({ enabled: true, rules: [], teamRules: [], requests, questions });

test("the groups come in order, Needs you first and Done last, and an empty one is left out", () => {
  expect(GROUP_ORDER).toEqual([
    "needs_input",
    "working",
    "failed",
    "ready_for_review",
    "resolved",
  ]);
  const groups = taskGroups({
    tasks: [
      task({ id: "done", status: "resolved", resolvedAt: at(10) }),
      task({ id: "read", status: "ready_for_review" }),
      task({ id: "ask", status: "needs_input" }),
      task({
        id: "broke",
        status: "failed",
        failure: "a service didn't answer",
      }),
    ],
  });
  expect(groups.map((group) => [group.id, group.label])).toEqual([
    ["needs_input", "Needs you"],
    ["failed", "Failed"],
    ["ready_for_review", "Ready for review"],
    ["resolved", "Done"],
  ]);
});

test("within a group, the task that moved last comes first, its conversation included", () => {
  const groups = taskGroups({
    tasks: [
      task({ id: "a", status: "ready_for_review", updatedAt: at(300) }),
      task({ id: "b", status: "ready_for_review", updatedAt: at(200) }),
    ],
    conversation: (channelId) =>
      channelId === "a-channel"
        ? { busy: false, lastMessageAt: at(2) }
        : undefined,
  });
  expect(groups[0]?.items.map((item) => item.task.id)).toEqual(["a", "b"]);
  expect(groups[0]?.items[0]?.at).toBe(at(2));
});

test("a task's own approval or question makes it Needs you, and says what it needs", () => {
  const groups = taskGroups({
    tasks: [
      task({ id: "rosa", status: "ready_for_review" }),
      task({ id: "sam", status: "working" }),
      task({ id: "kai", status: "working" }),
    ],
    requests: [
      request("mine", "rosa-thread"),
      // Decided already: nothing waits.
      request("decided", "kai-thread", "approved"),
      // Outside any task: listed on its Bot's page, not here.
      request("loose", "chat-thread"),
    ],
    questions: [question("asked", "sam-thread")],
  });
  const needs = groups.find((group) => group.id === "needs_input");
  expect(
    Object.fromEntries(
      needs?.items.map((item) => [item.task.id, item.next]) ?? [],
    ),
  ).toEqual({
    rosa: "Allow it to send your email, or decline",
    sam: "Which deck?",
  });
  expect(
    groups.find((group) => group.id === "working")?.items[0]?.task.id,
  ).toBe("kai");
});

test("a question a reply already answered no longer makes the task Needs you", () => {
  const answered = task({
    id: "answered",
    status: "failed",
    failure: "a service didn't answer",
    answeredQuestionIds: ["old"],
  });
  const questions = [question("old", "answered-thread")];
  const [group] = taskGroups({ tasks: [answered], questions });
  expect(group?.id).toBe("failed");
  expect(group?.items[0]?.next).toBe(
    "Couldn't finish: a service didn't answer.",
  );
  expect(needsYouCount([answered], inbox([], questions))).toBe(0);
  // A new question in the same conversation still waits.
  expect(
    needsYouCount([answered], inbox([], [question("new", "answered-thread")])),
  ).toBe(1);
});

test("a busy conversation reads Working, and one waiting on the person still reads Needs you", () => {
  const groups = taskGroups({
    tasks: [
      task({ id: "read", status: "ready_for_review" }),
      task({ id: "wait", status: "needs_input" }),
    ],
    conversation: () => ({ busy: true, lastMessageAt: null }),
  });
  expect(
    groups.map((group) => [group.id, group.items.map((item) => item.task.id)]),
  ).toEqual([
    ["needs_input", ["wait"]],
    ["working", ["read"]],
  ]);
});

test("the line under a title: the Bot's own next step, or what each state is waiting for", () => {
  const next = (overrides: Partial<TaskRecord> & { id: string }) =>
    taskItem(task(overrides), undefined, undefined).next;
  expect(next({ id: "a", status: "working" })).toBe("Just started");
  expect(next({ id: "b", status: "working", next: "“Make it shorter”" })).toBe(
    "“Make it shorter”",
  );
  expect(next({ id: "c", status: "needs_input" })).toBe("Open it to answer");
  expect(
    next({ id: "d", status: "needs_input", next: "Tuesday or Wednesday?" }),
  ).toBe("Tuesday or Wednesday?");
  expect(next({ id: "e", status: "failed" })).toBe("Couldn't finish.");
  expect(next({ id: "f", status: "ready_for_review" })).toBe(
    "Open it to read what it did",
  );
  expect(
    next({
      id: "g",
      status: "ready_for_review",
      why: "Ana needs it by Friday",
    }),
  ).toBe("Ana needs it by Friday");
  expect(couldNotFinish("a service didn't answer")).toBe(
    "Couldn't finish: a service didn't answer.",
  );
});

test("the sidebar's count is the Needs you group: waiting tasks once, nothing outside a task", () => {
  const tasks = [
    task({ id: "rosa", status: "needs_input" }),
    task({ id: "sam", status: "working" }),
    task({ id: "kai", status: "ready_for_review" }),
  ];
  expect(
    needsYouCount(
      tasks,
      inbox(
        [
          request("rosa-own", "rosa-thread"),
          request("sam-own", "sam-thread"),
          request("loose", "chat-thread"),
        ],
        [question("q", "chat-thread")],
      ),
    ),
  ).toBe(2);
  expect(needsYouCount(undefined, undefined)).toBe(0);
});

/** How long until a query reads again, for a cache holding `data`. */
const nextReadIn = (
  options: { refetchInterval?: unknown },
  data?: unknown,
): unknown =>
  typeof options.refetchInterval === "function"
    ? options.refetchInterval({ state: { data } })
    : options.refetchInterval;

test("tasks are read every few seconds only while one is working, and now and then otherwise", () => {
  const list = (status: TaskStatus) =>
    nextReadIn(taskListQueryOptions(), [
      task({ id: "done", status: "resolved" }),
      task({ id: "it", status }),
    ]);
  const one = (status: TaskStatus) =>
    nextReadIn(taskQueryOptions("it"), task({ id: "it", status }));
  const report = (status: TaskStatus) =>
    nextReadIn(taskReportQueryOptions("it", status));
  for (const read of [list, one, report]) {
    const quiet = read("ready_for_review");
    expect(read("working")).toBeLessThan(quiet as number);
    // Waiting on the person is quiet: an answer given here reads the tasks again at once.
    expect(read("needs_input")).toBe(quiet);
    expect(read("failed")).toBe(quiet);
  }
});

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("an answer given here reads the tasks again, so the task it was in moves off Needs you at once", async () => {
  globalThis.fetch = (async () =>
    Response.json({ status: "approved" })) as unknown as typeof fetch;
  const answers = [
    (cache: QueryClient) =>
      new MutationObserver(cache, decideApprovalMutationOptions(cache)).mutate({
        id: "r-1",
        choice: "allow_once",
      }),
    (cache: QueryClient) =>
      new MutationObserver(
        cache,
        answerPersonQuestionMutationOptions(cache),
      ).mutate({ id: "q-1", response: "The blue one" }),
  ];
  for (const answer of answers) {
    const cache = new QueryClient();
    cache.setQueryData(taskKeys.list(), [
      task({ id: "ask", status: "needs_input" }),
    ]);
    await answer(cache);
    expect(cache.getQueryState(taskKeys.list())?.isInvalidated).toBe(true);
  }
});
