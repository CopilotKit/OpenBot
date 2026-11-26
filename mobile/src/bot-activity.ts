/**
 * What a Bot is doing for the person, in the groups its Activity screen lists, as the web app's
 * `groupActivity` (app/src/lib/bot-lifecycle/activity-groups.ts). Two reads feed it: the Bot's activity
 * (its routines, goals, hand-offs, follow-ups and what it asked), and the person's tasks with it. Each
 * entry lands in one group by where it stands, and a group with nothing in it is left out. It imports
 * nothing that needs a phone, so it can be tested.
 */
import type { BotActivity, BotActivityItem, Task } from "./api/generated/model";

export type ActivityGroupId =
  | "needs_you"
  | "working"
  | "scheduled"
  | "done"
  | "stopped"
  | "failed"
  | "recurring";

/** Top to bottom: what waits on the person, what runs, what is lined up, how it ended, what recurs. */
export const ACTIVITY_GROUPS: readonly {
  id: ActivityGroupId;
  title: string;
}[] = [
  { id: "needs_you", title: "Needs you" },
  { id: "working", title: "Working" },
  { id: "scheduled", title: "Scheduled" },
  { id: "done", title: "Done" },
  { id: "stopped", title: "Stopped" },
  { id: "failed", title: "Failed" },
  { id: "recurring", title: "Recurring" },
];

export type ActivityEntry =
  | { kind: "task"; key: string; task: Task }
  | { kind: "item"; key: string; item: BotActivityItem; live: boolean };

export type ActivityGroup = {
  id: ActivityGroupId;
  title: string;
  entries: ActivityEntry[];
};

const KIND_LABEL: Record<string, string> = {
  routine: "Routine",
  responsibility: "Goal",
  handoff: "Delegated task",
  approval: "Approval",
  question: "Question",
  follow_up: "Follow-up",
};

/** A kind as a person reads it. One a newer server sends that this app doesn't know has no label. */
export function kindLabel(kind: string): string | undefined {
  return KIND_LABEL[kind];
}

/** Whether the person stopped a task: it reads Stopped, not Failed. */
export function stoppedByYou(task: Pick<Task, "status" | "stoppedAt">) {
  return task.status === "failed" && Boolean(task.stoppedAt);
}

/**
 * Where a task stands. One whose Bot has finished is done. A status this app doesn't know is not
 * waiting on the person, and is listed as done, as the web app lists it.
 */
export function taskGroup(
  task: Pick<Task, "status" | "stoppedAt">,
): ActivityGroupId {
  if (task.status === "needs_input") return "needs_you";
  if (task.status === "working") return "working";
  if (task.status === "failed")
    return stoppedByYou(task) ? "stopped" : "failed";
  return "done";
}

/** Whether Stop is offered on a task: while it works or waits on the person. */
export function canStopTask(task: Pick<Task, "status">): boolean {
  return task.status === "working" || task.status === "needs_input";
}

const TASK_LABEL: Record<string, string> = {
  working: "Working",
  needs_input: "Needs input",
  ready_for_review: "Ready for review",
  failed: "Failed",
  resolved: "Done",
};

/** A task's state in a word or two. Under Done it is always Done. One this app doesn't know has none. */
export function taskLabel(
  task: Pick<Task, "status" | "stoppedAt">,
  group: ActivityGroupId,
): string | undefined {
  if (stoppedByYou(task)) return "Stopped";
  if (group === "done") return "Done";
  return TASK_LABEL[task.status];
}

/**
 * Whether a lined-up item is one of the Bot's routines (a goal is one too). A follow-up, a queued run of
 * a goal and a delegated task waiting its turn are not.
 */
export function isRoutine(item: Pick<BotActivityItem, "kind" | "id">) {
  return (
    item.kind === "routine" ||
    (item.kind === "responsibility" &&
      !item.id.startsWith("responsibility-run:"))
  );
}

/** The routine an item is, by its id in the activity (`routine:<id>`), or none. */
export function routineIdOf(item: Pick<BotActivityItem, "kind" | "id">) {
  return item.kind === "routine" && item.id.startsWith("routine:")
    ? item.id.slice("routine:".length)
    : undefined;
}

const time = (iso: string | null | undefined) => {
  const at = iso ? Date.parse(iso) : Number.NaN;
  return Number.isFinite(at) ? at : 0;
};

const at = (entry: ActivityEntry) =>
  entry.kind === "task" ? time(entry.task.updatedAt) : time(entry.item.at);

/**
 * One Bot's activity in its groups, without the empty ones. `tasks` are the Bot's own. An approval or
 * a question asked inside one of those tasks' conversations is that task needing the person, so it is
 * listed once, as the task. Newest first in each group, scheduled runs soonest first, and Recurring keeps
 * routines, then the goals that run only when asked.
 */
export function groupActivity({
  activity,
  tasks,
}: {
  activity: BotActivity;
  tasks: readonly Task[];
}): ActivityGroup[] {
  const groups: Record<ActivityGroupId, ActivityEntry[]> = {
    needs_you: [],
    working: [],
    scheduled: [],
    done: [],
    stopped: [],
    failed: [],
    recurring: [],
  };
  const taskConversations = new Set(tasks.map((task) => task.conversationId));
  for (const task of tasks)
    groups[taskGroup(task)].push({
      kind: "task",
      key: `task:${task.id}`,
      task,
    });

  const entry = (item: BotActivityItem, live = false): ActivityEntry => ({
    kind: "item",
    key: `item:${item.id}`,
    item,
    live,
  });

  for (const item of activity.inProgress ?? []) {
    const asked = item.kind === "approval" || item.kind === "question";
    if (
      asked &&
      item.channelId !== null &&
      taskConversations.has(item.channelId)
    )
      continue;
    if (item.status === "failed") groups.failed.push(entry(item));
    else if (item.needsYou) groups.needs_you.push(entry(item, true));
    else groups.working.push(entry(item, true));
  }
  for (const item of activity.scheduled ?? [])
    (isRoutine(item) ? groups.recurring : groups.scheduled).push(entry(item));
  for (const item of activity.completed ?? [])
    groups[item.status === "failed" ? "failed" : "done"].push(entry(item));

  for (const id of [
    "needs_you",
    "working",
    "done",
    "stopped",
    "failed",
  ] as const)
    groups[id].sort((a, b) => at(b) - at(a));
  groups.scheduled.sort((a, b) => at(a) - at(b));
  for (const item of activity.onDemand ?? [])
    groups.recurring.push(entry(item));

  return ACTIVITY_GROUPS.map(({ id, title }) => ({
    id,
    title,
    entries: groups[id],
  })).filter((group) => group.entries.length > 0);
}

/** An item's second line: its kind, where it stands (or that it needs you), when, and its detail. */
export function itemLine(item: BotActivityItem, when: string): string {
  return [
    kindLabel(item.kind),
    item.needsYou ? "needs you" : item.status,
    when,
    item.detail,
  ]
    .filter(Boolean)
    .join(" · ");
}

/**
 * The Activity row's one line: what is running, lined up, and waiting to be asked. Finished work is only
 * mentioned when there is nothing else to say. Counted from what the Activity screen lists.
 */
export function activitySummary(
  activity: BotActivity,
  groups: readonly ActivityGroup[],
): string {
  const count = (id: ActivityGroupId) =>
    groups.find((group) => group.id === id)?.entries.length ?? 0;
  const inProgress = count("needs_you") + count("working");
  const scheduled = activity.scheduled?.length ?? 0;
  const onDemand = activity.onDemand?.length ?? 0;
  const parts = [
    inProgress ? `${inProgress} in progress` : null,
    scheduled ? `${scheduled} scheduled` : null,
    onDemand ? `${onDemand} on demand` : null,
  ].filter(Boolean);
  if (parts.length) return parts.join(" · ");
  return groups.length
    ? "Nothing running or scheduled"
    : "No tasks, routines or goals yet";
}
