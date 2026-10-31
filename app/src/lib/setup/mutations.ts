import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { client } from "@/lib/client";
import { type SetupChecklist, setupKeys } from "./queries";

/**
 * "Check again": the server asks Intelligence, the model provider and the computers again, then
 * answers. Asking them is the server's job, and it holds the keys; the browser only says when.
 *
 * Invalidated rather than written into the cache, as every write here is. The read that follows is
 * answered from what the check just learned, so it costs a round trip and no second check.
 */
export function recheckSetupMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (): Promise<SetupChecklist> =>
      client("/api/setup/check", "checklist", {
        method: "POST",
        fallback: "Couldn't check your setup.",
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: setupKeys.all }),
  });
}
