import type { ProactiveSetting } from "@/lib/proactive";
import { type ListedTask, onTheBoard } from "@/lib/tasks/groups";
import { stoppedByYou } from "@/lib/tasks/queries";
import type { ActivityItem, BotActivity } from "./queries";

/*
 * How a Bot's Activity page groups what the Bot is doing for the person, worked out here, away from
 * the screen, so the rule can be tested without drawing.
 *
 * Two reads feed it. The Bot's activity names its routines, goals, hand-offs, follow-ups and what it
 * asked the person. The person's tasks are the conversations the Bot opened to do a piece of work
 * in. Each entry lands in one group, by where it stands, and a group with nothing in it is left out.
 */

export type ActivityGroupId =
  | "needs_you"
  | "working"
  | "scheduled"
  | "done"
  | "stopped"
  | "failed"
  | "recurring";

/**
 * Top to bottom: what waits on the person, what is running, what is lined up, then how it ended. A
 * task the person stopped ended by their own choice, so it is listed apart from what failed.
 */
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
  | { kind: "task"; key: string; listed: ListedTask }
  | { kind: "item"; key: string; item: ActivityItem; live: boolean }
  | { kind: "check_in"; key: string; checkIn: ProactiveSetting };

export type ActivityGroup = {
  id: ActivityGroupId;
  title: string;
  entries: ActivityEntry[];
};

/**
 * Whether a lined-up item is one of the Bot's routines (a goal is a routine too), so its Routines
 * page lists it. A follow-up the Bot scheduled for itself, a queued run of a goal and a delegated
 * task waiting its turn are not on that page.
 */
export function isRoutine(item: ActivityItem): boolean {
  return (
    item.kind === "routine" ||
    (item.kind === "responsibility" &&
      !item.id.startsWith("responsibility-run:"))
  );
}

const time = (iso: string | null | undefined) => {
  const at = iso ? Date.parse(iso) : Number.NaN;
  return Number.isFinite(at) ? at : 0;
};

const at = (entry: ActivityEntry) =>
  entry.kind === "task"
    ? time(entry.listed.task.updatedAt)
    : entry.kind === "item"
      ? time(entry.item.at)
      : time(entry.checkIn.nextRunAt);

/**
 * Where a task stands on this page. One whose Bot has replied is done, as its card says. One the
 * person stopped reads Stopped, as its card and row say, so it is not listed under Failed. Read off
 * the live status, so a stopped task whose conversation is running a turn again is Working.
 */
function taskGroup({ task, status }: ListedTask): ActivityGroupId {
  if (status === "needs_input") return "needs_you";
  if (status === "working") return "working";
  if (status === "failed") return stoppedByYou(task) ? "stopped" : "failed";
  return "done";
}

/**
 * One Bot's activity in its groups, in `ACTIVITY_GROUPS` order, without the empty ones.
 *
 * - `tasks` are this Bot's, already in their live state.
 * - An approval or a question raised inside a listed task's conversation is that task needing the
 *   person, so it is shown once, as the task.
 * - A routine that runs a goal is one of that goal's starts (`goalRoutineIds`), not a row of its
 *   own, as on the Routines page.
 * - `checkIns` are this Bot's check-ins that are on.
 *
 * Newest first within a group. Scheduled runs soonest first. Recurring keeps routines, then goals,
 * then check-ins.
 */
export function groupActivity({
  activity,
  tasks,
  checkIns = [],
  goalRoutineIds = new Set(),
  boardAbove = false,
}: {
  activity: BotActivity;
  tasks: readonly ListedTask[];
  checkIns?: readonly ProactiveSetting[];
  goalRoutineIds?: ReadonlySet<string>;
  /**
   * The Needs you board is drawn above these groups and already lists the Bot's tasks and what it
   * asked the person, so neither is listed a second time and there is no second Needs you group.
   * A task the board leaves out (`onTheBoard`), one finished or marked done, is listed here.
   */
  boardAbove?: boolean;
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
  const taskConversations = new Set(tasks.map(({ task }) => task.channelId));

  for (const listed of boardAbove
    ? tasks.filter((entry) => !onTheBoard(entry))
    : tasks)
    groups[taskGroup(listed)].push({
      kind: "task",
      key: `task:${listed.task.id}`,
      listed,
    });

  const entry = (item: ActivityItem, live = false): ActivityEntry => ({
    kind: "item",
    key: `item:${item.id}`,
    item,
    live,
  });

  for (const item of activity.inProgress) {
    const inTask =
      (item.kind === "approval" || item.kind === "question") &&
      item.channelId !== null &&
      taskConversations.has(item.channelId);
    if (inTask) continue;
    const asked = item.kind === "approval" || item.kind === "question";
    if (boardAbove && asked) continue;
    if (item.status === "failed") groups.failed.push(entry(item));
    else if (item.needsYou && !boardAbove)
      groups.needs_you.push(entry(item, true));
    else groups.working.push(entry(item, true));
  }

  for (const item of activity.scheduled) {
    if (!isRoutine(item)) groups.scheduled.push(entry(item));
    else if (
      !(
        item.kind === "routine" &&
        goalRoutineIds.has(item.id.slice("routine:".length))
      )
    )
      groups.recurring.push(entry(item));
  }

  for (const item of activity.completed)
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
  for (const checkIn of checkIns)
    groups.recurring.push({
      kind: "check_in",
      key: `check-in:${checkIn.id}`,
      checkIn,
    });

  return ACTIVITY_GROUPS.map(({ id, title }) => ({
    id,
    title,
    entries: groups[id],
  })).filter((group) => group.entries.length > 0);
}
