import { describeApproval } from "@/lib/approval-view";
import type {
  ApprovalInboxData,
  ApprovalRequest,
  PersonQuestion,
} from "@/lib/approvals";
import {
  couldNotFinish,
  liveStatus,
  TASK_STATUS_LABEL,
  type TaskRecord,
  type TaskStatus,
} from "./queries";

/*
 * Tasks' list, grouped by what each task needs from the person: Needs you, Working, Failed, Ready for
 * review, Done. Worked out here, away from the screen, so the order, the next-step line and the
 * sidebar's count can be read and tested without drawing anything, and so the count and the list
 * can never disagree: both are this function.
 *
 * An approval or a question raised in a task's own conversation belongs to that task. The task says
 * what it needs, and the request is answered on the task's page. What waits outside any task stays on
 * the Bot's own page, where OpenBot already lists it.
 */

/** The groups, top to bottom. A task's status names the group it is in. */
export const GROUP_ORDER: readonly TaskStatus[] = [
  "needs_input",
  "working",
  "failed",
  "ready_for_review",
  "resolved",
];

/** What the conversation list knows about a task's conversation. */
export type ConversationFacts = { busy: boolean; lastMessageAt: string | null };

/** What waits on the person in one task's conversation. */
type Waiting = { request?: ApprovalRequest; question?: PersonQuestion };

export type TaskItem = {
  task: TaskRecord;
  /** Where it stands now: the server's word, moved on by what its conversation is doing. */
  status: TaskStatus;
  /** One line: what it needs next, or what it last said. */
  next: string;
  /** When anything last happened in it, for the order within a group. */
  at: string;
};

export type TaskGroup = { id: TaskStatus; label: string; items: TaskItem[] };

/** What waits on the person in each task's conversation, by the thread it was raised in. */
function waitingByTask(
  tasks: readonly TaskRecord[],
  requests: readonly ApprovalRequest[],
  questions: readonly PersonQuestion[],
): Map<string, Waiting> {
  const taskOfThread = new Map<string, TaskRecord>();
  for (const task of tasks)
    if (task.threadId) taskOfThread.set(task.threadId, task);
  const waiting = new Map<string, Waiting>();
  for (const request of requests) {
    if (request.status !== "pending") continue;
    const task = taskOfThread.get(request.action.threadId);
    if (task) waiting.set(task.id, { request, ...waiting.get(task.id) });
  }
  for (const question of questions) {
    const task = taskOfThread.get(question.threadId);
    // A reply the server took already answers the questions waiting when it was sent.
    if (task && !task.answeredQuestionIds.includes(question.id))
      waiting.set(task.id, { question, ...waiting.get(task.id) });
  }
  return waiting;
}

/**
 * Where a task stands: the server's word, Working while its conversation runs a turn, and Needs you
 * as soon as something in its conversation waits on the person, even before the server's next read
 * says so.
 */
function statusOf(task: TaskRecord, busy: boolean, waits: boolean) {
  return waits ? "needs_input" : liveStatus(task.status, busy);
}

const lowerFirst = (text: string) =>
  text.charAt(0).toLowerCase() + text.slice(1);

/**
 * What a task needs next, on the line under its title. A question it stopped on is the question
 * itself, an approval says what it would do, and a failed run says why. Otherwise it is the Bot's own
 * last line, or, before it has said anything, what the task is for.
 */
function nextOf(
  status: TaskStatus,
  waiting: Waiting | undefined,
  task: TaskRecord,
): string {
  const said = task.next?.trim() || null;
  if (status === "failed") return couldNotFinish(task.failure);
  if (status === "needs_input") {
    if (waiting?.question) return waiting.question.question;
    if (waiting?.request)
      return `Allow it to ${lowerFirst(describeApproval(waiting.request).title)}, or decline`;
    return said ?? "Open it to answer";
  }
  if (status === "working") return said ?? "Just started";
  return said ?? task.why ?? "Open it to read what it did";
}

const time = (iso: string | null | undefined) => {
  const at = iso ? Date.parse(iso) : Number.NaN;
  return Number.isFinite(at) ? at : 0;
};
const latest = (...times: (string | null | undefined)[]) =>
  times.reduce<string>(
    (best, next) => (next && time(next) > time(best) ? next : best),
    "",
  );

/**
 * Every task, placed in its group, newest activity first within each. A group with nothing in it is
 * left out.
 */
export function taskGroups(input: {
  tasks: readonly TaskRecord[];
  conversation?: (channelId: string) => ConversationFacts | undefined;
  requests?: readonly ApprovalRequest[];
  questions?: readonly PersonQuestion[];
}): TaskGroup[] {
  const waiting = waitingByTask(
    input.tasks,
    input.requests ?? [],
    input.questions ?? [],
  );
  const items = new Map<TaskStatus, TaskItem[]>(
    GROUP_ORDER.map((id) => [id, []]),
  );
  for (const task of input.tasks) {
    const facts = input.conversation?.(task.channelId);
    const waits = waiting.get(task.id);
    const status = statusOf(task, facts?.busy ?? false, Boolean(waits));
    items.get(status)?.push({
      task,
      status,
      next: nextOf(status, waits, task),
      at:
        status === "resolved"
          ? latest(task.resolvedAt, task.updatedAt)
          : latest(
              task.updatedAt,
              facts?.lastMessageAt,
              waits?.request?.createdAt,
              waits?.question?.createdAt,
            ),
    });
  }
  return GROUP_ORDER.flatMap((id) => {
    const listed = items.get(id) ?? [];
    if (listed.length === 0) return [];
    return [
      {
        id,
        label: TASK_STATUS_LABEL[id],
        // Stable, so tasks with the same time keep the server's newest-first order.
        items: [...listed].sort((a, b) => time(b.at) - time(a.at)),
      },
    ];
  });
}

/** Where one task stands and what it needs next, worked out as its row in the list would be. */
export function taskItem(
  task: TaskRecord,
  facts: ConversationFacts | undefined,
  inbox: ApprovalInboxData | undefined,
): TaskItem {
  const [group] = taskGroups({
    tasks: [task],
    conversation: () => facts,
    requests: inbox?.requests,
    questions: inbox?.questions,
  });
  // One task is always in exactly one group.
  return group?.items[0] as TaskItem;
}

/**
 * How many tasks wait on the person: the Needs you group, counted from the same grouping the list
 * draws, so the sidebar's number and the list never disagree.
 */
export function needsYouCount(
  tasks: readonly TaskRecord[] | undefined,
  inbox: ApprovalInboxData | undefined,
): number {
  return (
    taskGroups({
      tasks: tasks ?? [],
      requests: inbox?.requests,
      questions: inbox?.questions,
    }).find((group) => group.id === "needs_input")?.items.length ?? 0
  );
}
