import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { client } from "@/lib/client";
import { routineKeys } from "./queries";

/**
 * Writes against a person's own standing instructions.
 *
 * THERE IS NO CREATE AND NO EDIT HERE, on purpose: this page only shows and stops. Making a routine
 * and changing one are conversational, through the `RoutineTools` a Bot calls mid-chat — see
 * `server/src/routines/routes.ts` for the full reasoning.
 */

const FALLBACK = "That routine could not be changed.";

function invalidateRoutines(queryClient: QueryClient) {
  return queryClient.invalidateQueries({ queryKey: routineKeys.all });
}

/** Switch one routine on or off. Immediate; there is no save. */
export function setRoutineEnabledMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (variables: { id: string; enabled: boolean }) =>
      client(`/api/routines/${encodeURIComponent(variables.id)}/enabled`, {
        method: "PUT",
        body: { enabled: variables.enabled },
        fallback: FALLBACK,
      }),
    onSuccess: () => invalidateRoutines(queryClient),
  });
}

export function deleteRoutineMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (id: string) =>
      client(`/api/routines/${encodeURIComponent(id)}`, {
        method: "DELETE",
        fallback: FALLBACK,
      }),
    onSuccess: () => invalidateRoutines(queryClient),
  });
}
