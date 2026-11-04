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
