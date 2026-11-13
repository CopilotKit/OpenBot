import type { BotActivity } from "@/lib/bot-lifecycle/queries";
import { type MergedRoutine, needsALook } from "./merged";

/**
 * What a Bot does by itself, as its page lists it and a conversation's clock counts it: the rows of
 * its Routines page that are on, each with whether it is running now, whether it needs a look, when
 * it starts next, and whether it waits to be asked. Worked out here, from the reads the Routines
 * page makes and the Bot's activity, so the page's section and the clock count the same thing.
 */
export type OnRoutine = {
  row: MergedRoutine;
  /** Running now: an open routine run, a goal's run under way, a check-in looking. */
  running: boolean;
  /** Can't look, or failed last time. */
  needsLook: boolean;
  /** When it starts next, in ms, or null when nothing starts it on its own. */
  next: number | null;
  /** A goal that waits to be asked: nothing starts it on its own. */
  onDemand: boolean;
};

export type RoutineCounts = {
  running: number;
  scheduled: number;
  onDemand: number;
};

/** Whether a row is on: a routine switched on, a goal that is active, a check-in that is on. */
export function isOn(row: MergedRoutine): boolean {
  switch (row.kind) {
    case "routine":
      return row.routine.enabled;
    case "goal":
      return row.goal.status === "active";
    case "check-in":
      return row.checkIn.enabled;
  }
}

const time = (iso: string | null | undefined) => {
  const at = iso ? Date.parse(iso) : Number.NaN;
  return Number.isFinite(at) ? at : null;
};

function describe(
  row: MergedRoutine,
  activity: BotActivity | undefined,
): OnRoutine {
  switch (row.kind) {
    case "routine": {
      const { lastRun } = row.routine;
      return {
        row,
        running: lastRun !== null && lastRun.status === null,
        needsLook: lastRun?.status === "failed",
        next: time(row.routine.nextRunAt),
        onDemand: false,
      };
    }
    case "goal": {
      const { goal, routines } = row;
      const starts = routines.filter((routine) => routine.enabled);
      const nexts = starts
        .map((routine) => time(routine.nextRunAt))
        .filter((at): at is number => at !== null);
      /*
       * A goal's run carries no goal id in the activity, only its name and conversation: matched by
       * those, as the activity names it ("Run of …").
       */
      const runOfGoal = (activity?.inProgress ?? []).some(
        (item) =>
          item.kind === "responsibility" &&
          item.id.startsWith("responsibility-run:") &&
          item.title === `Run of ${goal.title}` &&
          item.channelId === goal.channelId,
      );
      // Asked of the activity, which knows its triggers too; else from what this read knows.
      const onDemand = activity
        ? (activity.onDemand ?? []).some(
            (item) => item.id === `responsibility:${goal.id}`,
          )
        : starts.length === 0 && goal.subscriptions.length === 0;
      return {
        row,
        running:
          runOfGoal ||
          routines.some(
            (routine) =>
              routine.lastRun !== null && routine.lastRun.status === null,
          ),
        needsLook: routines.some(
          (routine) => routine.lastRun?.status === "failed",
        ),
        next: nexts.length ? Math.min(...nexts) : null,
        onDemand,
      };
    }
    case "check-in": {
      const { checkIn } = row;
      return {
        row,
        running:
          checkIn.lastRun?.outcome === "running" ||
          checkIn.lastStatus === "running",
        needsLook: needsALook(row) || checkIn.lastRun?.outcome === "failed",
        next: time(checkIn.nextRunAt),
        onDemand: false,
      };
    }
  }
}

/**
 * The rows that are on, in the order a Bot's page lists them: running now, then the ones that need a
 * look, then by what starts next, then the goals that wait to be asked.
 */
export function routinesOn(
  rows: readonly MergedRoutine[],
  activity: BotActivity | undefined,
): OnRoutine[] {
  const rank = (on: OnRoutine) =>
    on.running ? 0 : on.needsLook ? 1 : on.onDemand ? 3 : 2;
  return rows
    .filter(isOn)
    .map((row) => describe(row, activity))
    .map((on, index) => ({ on, index }))
    .sort(
      (a, b) =>
        rank(a.on) - rank(b.on) ||
        (a.on.next ?? Number.POSITIVE_INFINITY) -
          (b.on.next ?? Number.POSITIVE_INFINITY) ||
        a.index - b.index,
    )
    .map(({ on }) => on);
}

/**
 * How many are running, scheduled and on demand, from the rows: a routine that runs a goal is its
 * goal's row, and a check-in that is on is scheduled.
 */
export function countRoutines(on: readonly OnRoutine[]): RoutineCounts {
  const running = on.filter((row) => row.running).length;
  const onDemand = on.filter((row) => !row.running && row.onDemand).length;
  return { running, scheduled: on.length - running - onDemand, onDemand };
}

/** "1 running · 3 scheduled · 1 on demand", each part left out at zero. */
export function routineCountsLine(counts: RoutineCounts): string {
  return [
    counts.running ? `${counts.running} running` : null,
    counts.scheduled ? `${counts.scheduled} scheduled` : null,
    counts.onDemand ? `${counts.onDemand} on demand` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}
