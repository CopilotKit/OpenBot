import { type BotTask, liveStatus, type TaskStatus } from "./queries";

/*
 * The order a person's tasks are listed in, worked out here, away from the screens, so the Bots page,
 * a Bot's page and the OpenDuet skin list them alike and the rule can be tested without drawing.
 * Ported from OpenDuet's Active list.
 */

/** Top to bottom: what to read, what to answer, what to retry, what is running, what is done. */
export const TASK_ORDER: readonly TaskStatus[] = [
  "ready_for_review",
  "needs_input",
  "failed",
  "working",
  "resolved",
];

/** How long a task the person marked done stays listed. */
export const RESOLVED_FOR_MS = 7 * 24 * 60 * 60 * 1000;

/** A task with where it stands right now, its conversation's live busy signal included. */
export type ListedTask = { task: BotTask; status: TaskStatus };

/** Whether a task in this state waits on the person: something to read, answer or try again. */
export function waitsOnYou(status: TaskStatus): boolean {
  return (
    status === "ready_for_review" ||
    status === "needs_input" ||
    status === "failed"
  );
}

/**
 * Whether a task is one a Bot delegated that has finished. Its result was already said in the
 * conversation that asked for it, and its Bot's Activity page lists it under Done, so it waits on
 * nobody: it is not counted, and no list of what needs the person shows it (`onTheBoard`).
 */
export function finishedDelegation({ task, status }: ListedTask): boolean {
  return task.origin === "delegated" && status === "ready_for_review";
}

/**
 * Whether the Needs you board lists a task: every task not marked done, less a delegated one that has
 * finished. Whatever lists the Bot's tasks under the board (OpenFuse's Activity) lists the rest, so
 * a task is always on one or the other.
 */
export function onTheBoard(listed: ListedTask): boolean {
  return listed.status !== "resolved" && !finishedDelegation(listed);
}

/**
 * Whether a listed task is one thing waiting on the person, by the rule the Bots badge counts by
 * (the server's task counts): something to read, answer or try again, less a delegated task that is
 * done (`finishedDelegation`). Every count of what waits on the person counts tasks by this, so the
 * numbers agree wherever they are shown.
 */
export function countsAsWaiting(listed: ListedTask): boolean {
  return waitsOnYou(listed.status) && !finishedDelegation(listed);
}

/** Where a question or an action waits: its conversation, its thread, or both. */
export type WaitingWhere = {
  channelId?: string | undefined;
  threadId?: string | undefined;
};

/**
 * Whether what waits somewhere waits inside one of these tasks' own conversations. It is then that
 * task waiting on the person, listed and counted once, as the task, the way the Bots badge counts
 * it. Every list that shows questions and actions beside tasks leaves these out by this one rule.
 */
export function heldByTaskOf(
  listed: readonly ListedTask[],
): (where: WaitingWhere) => boolean {
  const channels = new Set<string>();
  const threads = new Set<string>();
  for (const { task } of listed) {
    channels.add(task.channelId);
    if (task.threadId) threads.add(task.threadId);
  }
  return ({ channelId, threadId }) =>
    (channelId !== undefined && channels.has(channelId)) ||
    (threadId !== undefined && threads.has(threadId));
}

const time = (iso: string | null) => {
  const at = iso ? Date.parse(iso) : Number.NaN;
  return Number.isFinite(at) ? at : 0;
};

/**
 * The tasks in `TASK_ORDER`, newest first within each state. A task whose conversation is running a
 * turn reads Working, as `liveStatus` says. One marked done more than a week ago is left out: the
 * server already stops listing it then, and a list left open across the week should agree.
 */
export function orderTasks(
  tasks: readonly BotTask[],
  busy: (channelId: string) => boolean,
  now: number,
): ListedTask[] {
  return tasks
    .map((task) => ({
      task,
      status: liveStatus(task.status, busy(task.channelId)),
    }))
    .filter(
      ({ task, status }) =>
        status !== "resolved" ||
        now - time(task.resolvedAt ?? task.updatedAt) <= RESOLVED_FOR_MS,
    )
    .sort(
      (a, b) =>
        TASK_ORDER.indexOf(a.status) - TASK_ORDER.indexOf(b.status) ||
        time(b.task.updatedAt) - time(a.task.updatedAt),
    );
}
