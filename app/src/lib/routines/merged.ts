import type { ProactiveSetting } from "@/lib/proactive";
import type { ResponsibilityRecord } from "@/lib/responsibilities";
import type { RoutineRecord } from "./queries";

/**
 * One Routines list, per Bot and for every Bot, from three reads that stay three stores: routines,
 * goals (`responsibilities`) and check-ins (`proactive` settings). See
 * `docs/how-openbot-works.md`: a goal is a routine with an outcome to reach, and a check-in is a
 * routine that only tells you.
 *
 * Every row is the same sentence in four parts. What it is; when it starts; what it does (acts, or
 * only tells you); until when. A routine that runs a goal is not a row of its own: it is one of
 * that goal's starts, so the goal's row carries it.
 */
export type MergedRoutine =
  | { kind: "routine"; id: string; agentId: string; routine: RoutineRecord }
  | {
      kind: "goal";
      id: string;
      agentId: string;
      goal: ResponsibilityRecord;
      /** The routines that run it, which are starts of this row and not rows of their own. */
      routines: RoutineRecord[];
    }
  | {
      kind: "check-in";
      id: string;
      agentId: string;
      checkIn: ProactiveSetting;
    };

/** Whether a row is working now: on, active, not paused. Working rows come first. */
function working(row: MergedRoutine): boolean {
  switch (row.kind) {
    case "routine":
      return row.routine.enabled;
    case "goal":
      return row.goal.status === "active";
    case "check-in":
      return row.checkIn.enabled;
  }
}

const KIND_ORDER: Record<MergedRoutine["kind"], number> = {
  routine: 0,
  goal: 1,
  "check-in": 2,
};

/**
 * The rows, for one Bot or (with no `agentId`) every Bot. Working rows first; within that, routines,
 * then goals, then check-ins, each in the order its own read gave it. A routine whose goal is not
 * in the goals read (deleted, or another person's) stays a row of its own, so nothing goes missing.
 */
export function mergeRoutines({
  routines,
  goals,
  checkIns,
  agentId,
}: {
  routines: readonly RoutineRecord[];
  goals: readonly ResponsibilityRecord[];
  checkIns: readonly ProactiveSetting[];
  agentId?: string;
}): MergedRoutine[] {
  const mine = <T extends { agentId: string }>(rows: readonly T[]) =>
    rows.filter((row) => agentId === undefined || row.agentId === agentId);
  const goalIds = new Set(goals.map((goal) => goal.id));
  const rows: MergedRoutine[] = [
    ...mine(routines)
      .filter((routine) => !routine.goalId || !goalIds.has(routine.goalId))
      .map(
        (routine): MergedRoutine => ({
          kind: "routine",
          id: routine.id,
          agentId: routine.agentId,
          routine,
        }),
      ),
    ...mine(goals).map(
      (goal): MergedRoutine => ({
        kind: "goal",
        id: goal.id,
        agentId: goal.agentId,
        goal,
        routines: routines.filter((routine) => routine.goalId === goal.id),
      }),
    ),
    ...mine(checkIns).map(
      (checkIn): MergedRoutine => ({
        kind: "check-in",
        id: checkIn.id,
        agentId: checkIn.agentId,
        checkIn,
      }),
    ),
  ];
  return rows
    .map((row, index) => ({ row, index }))
    .sort(
      (a, b) =>
        Number(working(b.row)) - Number(working(a.row)) ||
        KIND_ORDER[a.row.kind] - KIND_ORDER[b.row.kind] ||
        a.index - b.index,
    )
    .map(({ row }) => row);
}

/** A check-in's interval, in words. */
export const CHECK_IN_INTERVALS = [
  { minutes: 60, label: "Every hour" },
  { minutes: 240, label: "Every 4 hours" },
  { minutes: 720, label: "Twice a day" },
  { minutes: 1440, label: "Once a day" },
] as const;

export function intervalLabel(minutes: number): string {
  return (
    CHECK_IN_INTERVALS.find((interval) => interval.minutes === minutes)
      ?.label ?? `Every ${minutes} minutes`
  );
}

/**
 * Whether a goal can end, so its row may say until when. One that ends when met can. Any other goal
 * ends only if nothing makes it run again and again: it isn't recurring, it listens for no events,
 * and no enabled schedule or trigger runs it. The server's `repeatsOf` reads the same four.
 *
 * `routines` and `triggers` are what runs it as far as they are known; unknown counts as nothing.
 */
export function goalCanEnd(
  goal: Pick<
    ResponsibilityRecord,
    "endsWhenMet" | "recurring" | "subscriptions"
  >,
  routines: readonly Pick<RoutineRecord, "enabled">[] | undefined,
  triggers: readonly { enabled: boolean }[] | undefined,
): boolean {
  if (goal.endsWhenMet) return true;
  return (
    !goal.recurring &&
    goal.subscriptions.length === 0 &&
    !(routines ?? []).some((routine) => routine.enabled) &&
    !(triggers ?? []).some((trigger) => trigger.enabled)
  );
}

/**
 * A goal's starts, in words: the events it listens for, its enabled triggers, and the schedule of
 * each routine that runs it. With none of those, "Schedule off" when it has schedules that are all
 * switched off, else "When you ask", once its triggers and its routines are both known; before
 * then, or when either couldn't be read, nothing is claimed.
 */
export function goalStarts(
  goal: ResponsibilityRecord,
  triggerWords: readonly string[] | undefined,
  routines: readonly RoutineRecord[] | undefined,
  sourceLabel: (
    source: ResponsibilityRecord["subscriptions"][number],
  ) => string,
): string | null {
  const starts = [
    ...(routines ?? [])
      .filter((routine) => routine.enabled)
      .map((routine) => routine.schedule),
    ...goal.subscriptions.map(sourceLabel),
    ...(triggerWords ?? []),
  ];
  if (starts.length) return starts.join(", ");
  if (!triggerWords || !routines) return null;
  return routines.length > 0 ? "Schedule off" : "When you ask";
}
