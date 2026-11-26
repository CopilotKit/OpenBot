import {
  IconClock,
  IconEye,
  IconLoader2,
  IconPlayerPause,
  IconTarget,
} from "@tabler/icons-react";
import { Link } from "@tanstack/react-router";
import { AnimatePresence } from "motion/react";
import { BotOrb } from "@/components/agents/bot-orb";
import { KIND_LABEL } from "@/components/responsibilities/triggers";
import { useGoalTriggers } from "@/components/responsibilities/use-goal-reads";
import { Unfold } from "@/components/routines/unfold";
import {
  type BotGroup,
  isOff,
  isRunning,
  type RowTone,
  rowFact,
  rowName,
} from "@/lib/routines/by-bot";
import { describeEvent } from "@/lib/routines/events";
import { goalStarts, type MergedRoutine } from "@/lib/routines/merged";
import { cn } from "@/lib/utils";

const ROW_CLASS =
  "flex flex-col gap-0.5 rounded-lg px-2 py-2 text-sm hover:bg-muted sm:flex-row sm:items-center sm:gap-3";

const FACT_CLASS: Record<RowTone, string> = {
  running: "text-foreground",
  warning: "text-warning",
  muted: "text-muted-foreground",
  normal: "text-muted-foreground",
};

function RowIcon({ row }: { row: MergedRoutine }) {
  const className = "size-4 shrink-0 text-muted-foreground";
  if (isRunning(row))
    return (
      <IconLoader2
        className={cn(className, "animate-spin motion-reduce:animate-none")}
      />
    );
  if (isOff(row)) return <IconPlayerPause className={className} />;
  switch (row.kind) {
    case "routine":
      return <IconClock className={className} />;
    case "goal":
      return <IconTarget className={className} />;
    case "check-in":
      return <IconEye className={className} />;
  }
}

/** A row's one line: its icon, its name, and the one fact about it. */
function RowLine({
  row,
  starts,
}: {
  row: MergedRoutine;
  /** A goal's starts in words; the others have none. */
  starts: string | null;
}) {
  const fact = rowFact(row, starts);
  return (
    <>
      <span className="flex min-w-0 flex-1 items-center gap-3">
        <RowIcon row={row} />
        <span className="truncate">{rowName(row)}</span>
      </span>
      <span
        className={cn("shrink-0 pl-7 text-sm sm:pl-0", FACT_CLASS[fact.tone])}
      >
        {fact.text}
      </span>
    </>
  );
}

/** Dimmed when its fact is the muted one: paused, or a goal that is completed. */
function rowClass(row: MergedRoutine, starts: string | null) {
  return cn(ROW_CLASS, rowFact(row, starts).tone === "muted" && "opacity-60");
}

/**
 * A goal's row. Its own component, so only an active goal reads its triggers (`useGoalTriggers`),
 * which its starts are made of.
 */
function GoalRow({ row }: { row: Extract<MergedRoutine, { kind: "goal" }> }) {
  const triggers = useGoalTriggers(row.goal.id, {
    enabled: row.goal.status === "active",
  });
  const starts = goalStarts(
    row.goal,
    triggers.data
      ?.filter((trigger) => trigger.enabled)
      .map((trigger) => `${KIND_LABEL[trigger.kind]} trigger`),
    row.routines,
    describeEvent,
  );
  return (
    <Link
      className={rowClass(row, starts)}
      params={{ goalId: row.goal.id }}
      to="/routines/goals/$goalId"
    >
      <RowLine row={row} starts={starts} />
    </Link>
  );
}

/** One row as the Routines page draws it, opening the routine, goal or check-in it is. */
export function GroupRow({ row }: { row: MergedRoutine }) {
  switch (row.kind) {
    case "routine":
      return (
        <Link
          className={rowClass(row, null)}
          params={{ routineId: row.routine.id }}
          to="/routines/schedules/$routineId"
        >
          <RowLine row={row} starts={null} />
        </Link>
      );
    case "goal":
      return <GoalRow row={row} />;
    case "check-in":
      return (
        <Link
          className={rowClass(row, null)}
          params={{ checkInId: row.checkIn.id }}
          to="/routines/check-ins/$checkInId"
        >
          <RowLine row={row} starts={null} />
        </Link>
      );
  }
}

/**
 * One Bot's routines on the Routines page: the Bot's orb, name and how many it has, then one line
 * per row. The name opens the Bot's own Routines page, except for "A Bot", a Bot no list knows,
 * which has none.
 */
export function BotGroupSection({ group }: { group: BotGroup }) {
  return (
    // Spaced with padding, not margin: the group's height opens and folds, and a margin outside it
    // would jump.
    <section aria-label={group.name} className="pb-6">
      <div className="flex items-center gap-2 px-2 pb-1.5 text-muted-foreground text-sm">
        <BotOrb name={group.name} seed={group.seed} size={18} />
        {group.known ? (
          <Link
            className="font-medium text-foreground hover:underline"
            params={{ agentId: group.botId }}
            to="/bots/$agentId/routines"
          >
            {group.name}
          </Link>
        ) : (
          <span className="font-medium text-foreground">{group.name}</span>
        )}
        <span className="tabular-nums">{group.rows.length}</span>
      </div>
      {/* A routine made or removed while the page is open opens or folds; the rest just appear. */}
      <AnimatePresence initial={false}>
        {group.rows.map((row) => (
          <Unfold key={`${row.kind}:${row.id}`}>
            <GroupRow row={row} />
          </Unfold>
        ))}
      </AnimatePresence>
    </section>
  );
}
