import { expect, test } from "bun:test";
import type { StalledHandoff } from "@/components/needs-you/stalled-handoffs";
import type { ApprovalInboxData } from "@/lib/approvals";
import { briefingLine, needsYouEntries } from "@/lib/places/openbot-sections";
import type { ListedTask } from "@/lib/tasks/groups";
import type { BotTask } from "@/lib/tasks/queries";

/*
 * What the home page says needs the person: one list across questions, actions, tasks and stalled
 * hand-offs, the longest wait first, and the one line that counts it.
 */

type Question = ApprovalInboxData["questions"][number];
type Request = ApprovalInboxData["requests"][number];

const at = (minute: number) =>
  new Date(Date.parse("2026-11-17T10:00:00Z") + minute * 60_000).toISOString();

const listed = (
  id: string,
  status: BotTask["status"],
  updatedAt: string,
  origin: BotTask["origin"] = "check_in",
): ListedTask => ({
  status,
  task: {
    id,
    agentId: "inbox",
    channelId: `c-${id}`,
    threadId: `t-${id}`,
    title: id,
    why: null,
    origin,
    suggestionId: null,
    sourceApp: null,
    sourceLink: null,
    originChannelId: null,
    status,
    failure: null,
    failedAt: null,
    stoppedAt: null,
    next: null,
    resolvedAt: null,
    createdAt: updatedAt,
    updatedAt,
  },
});

const question = (
  id: string,
  threadId: string,
  createdAt: string,
): Question => ({
  id,
  botId: "inbox",
  threadId,
  question: "Which one?",
  createdAt,
});

const request = (id: string, threadId: string, createdAt: string): Request => ({
  id,
  status: "pending",
  createdAt,
  action: {
    botId: "inbox",
    toolRef: "mail.send",
    effect: "write",
    scope: "mail",
    threadId,
  },
});

const handoff = (id: string, when: string): StalledHandoff => ({
  botId: "inbox",
  item: {
    id,
    kind: "handoff",
    title: id,
    detail: null,
    status: "stalled",
    at: when,
    channelId: null,
    needsYou: true,
    stoppable: false,
    cancellable: false,
  },
});

const entries = (input: Partial<Parameters<typeof needsYouEntries>[0]>) =>
  needsYouEntries({
    questions: [],
    requests: [],
    tasks: [],
    done: [],
    handoffs: [],
    ...input,
  });

test("a question a task holds is the task's row, not a second one", () => {
  const result = entries({
    tasks: [listed("1", "needs_input", at(5))],
    questions: [question("q1", "t-1", at(1))],
  });
  expect(result.map((entry) => entry.kind)).toEqual(["task"]);
});

test("a delegated task that finished and a working task are not waiting", () => {
  const result = entries({
    tasks: [
      listed("1", "ready_for_review", at(1), "delegated"),
      listed("2", "working", at(2)),
    ],
  });
  expect(result).toEqual([]);
});

test("the longest wait comes first", () => {
  const result = entries({
    questions: [question("q", "t-q", at(30))],
    requests: [request("r", "t-r", at(10))],
    tasks: [listed("1", "needs_input", at(20))],
    handoffs: [handoff("h", at(5))],
  });
  expect(result.map((entry) => `${entry.kind}:${entry.id}`)).toEqual([
    "handoff:h",
    "request:r",
    "task:1",
    "question:q",
  ]);
});

test("the briefing says only what there is", () => {
  expect(briefingLine(3, 2)).toBe("3 need you. 2 working.");
  expect(briefingLine(1, 0)).toBe("1 needs you.");
  expect(briefingLine(0, 1)).toBe("1 working.");
  expect(briefingLine(0, 0)).toBeNull();
});
