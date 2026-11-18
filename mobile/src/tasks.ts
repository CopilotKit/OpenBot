import type { Task } from "./api";

const TASK_LABEL: Record<string, string> = {
  ready_for_review: "Ready for review",
  needs_input: "Needs input",
  failed: "Failed",
  working: "Working",
  resolved: "Resolved",
};

/** Top to bottom, as on the web: what to read, what to answer, what to retry. */
const WAITS_ON_YOU: readonly string[] = [
  "ready_for_review",
  "needs_input",
  "failed",
];

/** The tasks that wait on the person, in the order they are listed, newest first within each. */
export function waitingTasks(tasks: readonly Task[]): Task[] {
  return tasks
    .filter((task) => WAITS_ON_YOU.includes(task.status))
    .sort(
      (a, b) =>
        WAITS_ON_YOU.indexOf(a.status) - WAITS_ON_YOU.indexOf(b.status) ||
        Date.parse(b.updatedAt) - Date.parse(a.updatedAt),
    );
}

/**
 * A task card's second line: the Bot, and where the task stands. A status a newer server sends that
 * this app doesn't know leaves the Bot's name alone.
 */
export function taskLine(botName: string, status: string): string {
  const label = TASK_LABEL[status];
  return label ? `${botName} · ${label}` : botName;
}
