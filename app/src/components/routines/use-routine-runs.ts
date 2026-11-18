import { useQuery } from "@tanstack/react-query";
import { deleteRoutineMutationKey } from "@/lib/routines/mutations";
import { routineRunsQueryOptions } from "@/lib/routines/queries";
import { useDeletedHere } from "./routine-detail-missing";

/**
 * A routine's runs, read until the routine is deleted from this browser.
 *
 * The runs are polled while a routine is on screen, and the screen stays up for a moment after a
 * delete: its list is still being read again, which is what takes it down. A read in that moment
 * asks for the runs of a routine that is gone and is answered 404. So from the moment a delete of
 * this routine is on its way, its runs are not read: the delete drops what was read
 * (`deleteRoutineMutationOptions`), and nothing here asks again.
 */
export function useRoutineRuns(routineId: string) {
  const deleted = useDeletedHere<string>(
    deleteRoutineMutationKey,
    (id) => id === routineId,
  );
  return useQuery({
    ...routineRunsQueryOptions(routineId),
    enabled: !deleted,
  });
}
