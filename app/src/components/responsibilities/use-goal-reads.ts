import { useQuery } from "@tanstack/react-query";
import { useDeletedHere } from "@/components/routines/routine-detail-missing";
import {
  deleteResponsibilityMutationKey,
  responsibilityRunsQueryOptions,
  triggersQueryOptions,
} from "@/lib/responsibilities";

/**
 * A goal's triggers and runs, read until the goal is deleted from this browser.
 *
 * A goal's page, and its row on the Routines list, stay up for a moment after a delete: the list of
 * goals is still being read again, which is what takes them down. A read in that moment asks for the
 * triggers or runs of a goal that is gone and is answered 404. So from the moment a delete of this
 * goal is on its way, they are not read: the delete drops what was read
 * (`deleteResponsibilityMutationOptions`), and nothing here asks again.
 */
function useGoalDeletedHere(goalId: string) {
  return useDeletedHere<string>(
    deleteResponsibilityMutationKey,
    (id) => id === goalId,
  );
}

/** The goal's triggers. `enabled: false` is for a reader that does not need them yet. */
export function useGoalTriggers(goalId: string, { enabled = true } = {}) {
  const deleted = useGoalDeletedHere(goalId);
  return useQuery({
    ...triggersQueryOptions(goalId),
    enabled: enabled && !deleted,
  });
}

export function useGoalRuns(goalId: string) {
  const deleted = useGoalDeletedHere(goalId);
  return useQuery({
    ...responsibilityRunsQueryOptions(goalId),
    enabled: !deleted,
  });
}
