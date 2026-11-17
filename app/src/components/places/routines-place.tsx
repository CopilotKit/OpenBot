import { IconPlus } from "@tabler/icons-react";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { groupRoutinesByBot } from "@/lib/places/routine-groups";
import {
  isWorking,
  type MergedRoutine,
  routineDoes,
} from "@/lib/routines/merged";
import { useMergedRoutines } from "@/lib/routines/use-merged";
import { cn } from "@/lib/utils";
import {
  PlaceEmpty,
  type PlaceEntry,
  PlaceHeading,
  PlaceRow,
} from "./place-row";

/** "routines", "routines and goals", "routines, goals and check-ins". */
function listOf(names: string[]): string {
  if (names.length < 2) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

function RoutinesPlace() {
  const { rows, bots, pending, failed } = useMergedRoutines();
  const nameOf = (agentId: string) => bots.get(agentId)?.name ?? "A Bot";
  if (pending) return null;

  return (
    <div className="flex flex-col pb-2">
      {failed.length > 0 ? (
        <p className="px-2 py-3 text-muted-foreground text-xs" role="alert">
          Couldn't load your {listOf(failed)}. Try again in a moment.
        </p>
      ) : null}
      {rows.length === 0 && failed.length === 0 ? (
        <PlaceEmpty>No routines yet. Start one with New routine.</PlaceEmpty>
      ) : null}
      {groupRoutinesByBot(rows, nameOf).map((group) => (
        <section key={group.agentId}>
          <PlaceHeading>{nameOf(group.agentId)}</PlaceHeading>
          {group.rows.map((row) => (
            <RoutineItem key={`${row.kind}:${row.id}`} row={row} />
          ))}
        </section>
      ))}
    </div>
  );
}

function RoutineItem({ row }: { row: MergedRoutine }) {
  const dimmed = !isWorking(row);
  if (row.kind === "routine") {
    return (
      <PlaceRow
        title={
          <Title dimmed={dimmed}>
            {row.routine.title ?? routineDoes(row.routine)}
          </Title>
        }
        to={{
          to: "/routines/schedules/$routineId",
          params: { routineId: row.id },
        }}
      />
    );
  }
  if (row.kind === "goal") {
    const { goal } = row;
    return (
      <PlaceRow
        detail={
          goal.progress && goal.status !== "completed"
            ? goal.progress
            : undefined
        }
        title={<Title dimmed={dimmed}>{goal.title}</Title>}
        to={{ to: "/routines/goals/$goalId", params: { goalId: row.id } }}
        trailing={<span className="text-muted-foreground text-xs">Goal</span>}
      />
    );
  }
  return (
    <PlaceRow
      title={<Title dimmed={dimmed}>{row.checkIn.subject || "Check-in"}</Title>}
      to={{
        to: "/routines/check-ins/$checkInId",
        params: { checkInId: row.id },
      }}
    />
  );
}

function Title({ dimmed, children }: { dimmed: boolean; children: ReactNode }) {
  return <span className={cn(dimmed && "opacity-60")}>{children}</span>;
}

function NewRoutineAction() {
  return (
    <Button
      aria-label="New routine"
      render={<Link to="/routines/new" />}
      size="icon-sm"
      variant="ghost"
    >
      <IconPlus />
    </Button>
  );
}

export const routinesPlace: PlaceEntry = {
  List: RoutinesPlace,
  Action: NewRoutineAction,
};
