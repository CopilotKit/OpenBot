import { IconClock, IconHistory, IconTrash } from "@tabler/icons-react";
import { useMutation } from "@tanstack/react-query";
import { Fragment, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemFooter,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import {
  deleteRoutineMutationOptions,
  setRoutineEnabledMutationOptions,
} from "@/lib/routines/mutations";
import type { RoutineRecord } from "@/lib/routines/queries";
import { queryClient } from "@/query-client";
import { LastRunChip, RoutineRuns } from "./routine-runs";

/**
 * The routines that run a goal, inside the goal's dialog. On the Routines list such a routine is a
 * start of the goal's row rather than a row of its own, so this is where it is switched off or
 * deleted, through the same mutations its own row used, and where its last run and its history are,
 * as its own row showed them (`routine-runs.tsx`).
 */
export function GoalSchedules({
  paused = false,
  routines,
}: {
  /** The goal is paused, so an enabled schedule waits for it to resume. */
  paused?: boolean;
  routines: readonly RoutineRecord[];
}) {
  const setEnabled = useMutation(setRoutineEnabledMutationOptions(queryClient));
  const remove = useMutation(deleteRoutineMutationOptions(queryClient));
  /** The schedule a delete is being confirmed for. A second press deletes it. */
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  /** Which schedule's run history is open. One at a time, as on the Routines list. */
  const [historyId, setHistoryId] = useState<string | null>(null);
  if (routines.length === 0) return null;
  return (
    <div className="overflow-hidden rounded-lg">
      {routines.map((routine, index) => (
        <Fragment key={routine.id}>
          {index > 0 ? <Separator /> : null}
          <Item size="sm" variant="muted">
            <ItemMedia variant="icon">
              <IconClock />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>{routine.schedule}</ItemTitle>
              <ItemDescription>
                {routine.enabled
                  ? paused
                    ? `Starts it again when you resume it · ${routine.timezone}`
                    : `Starts it on a schedule · ${routine.timezone}`
                  : "Off. This schedule won't start it."}
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              <Switch
                aria-label={`Start it ${routine.schedule}`}
                checked={routine.enabled}
                disabled={
                  setEnabled.isPending &&
                  setEnabled.variables?.id === routine.id
                }
                onCheckedChange={(next) =>
                  setEnabled.mutate({ id: routine.id, enabled: next })
                }
              />
              <Button
                aria-label={
                  confirmingId === routine.id
                    ? `Confirm deleting the schedule ${routine.schedule}`
                    : `Delete the schedule ${routine.schedule}`
                }
                disabled={remove.isPending}
                onClick={() => {
                  if (confirmingId !== routine.id) {
                    remove.reset();
                    setConfirmingId(routine.id);
                    return;
                  }
                  remove.mutate(routine.id, {
                    onSuccess: () => setConfirmingId(null),
                  });
                }}
                size="sm"
                type="button"
                variant={confirmingId === routine.id ? "destructive" : "ghost"}
              >
                <IconTrash />
                {confirmingId === routine.id ? "Delete for good" : null}
              </Button>
            </ItemActions>
            <ItemFooter className="flex-wrap">
              <LastRunChip lastRun={routine.lastRun} />
              <Button
                aria-expanded={historyId === routine.id}
                aria-label={`Run history for the schedule ${routine.schedule}`}
                onClick={() =>
                  setHistoryId(historyId === routine.id ? null : routine.id)
                }
                size="sm"
                type="button"
                variant="ghost"
              >
                <IconHistory />
                History
              </Button>
            </ItemFooter>
            {historyId === routine.id ? (
              <div className="basis-full border-border border-t pt-2">
                <RoutineRuns routine={routine} />
              </div>
            ) : null}
          </Item>
        </Fragment>
      ))}
      {setEnabled.error || remove.error ? (
        <p className="mt-2 text-destructive text-sm" role="alert">
          {setEnabled.error?.message ?? remove.error?.message}
        </p>
      ) : null}
    </div>
  );
}
