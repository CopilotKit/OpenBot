import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { client } from "@/lib/client";
import { settingsKeys } from "./queries";

/**
 * Save, or clear by saving nothing.
 *
 * A PUT of the whole text rather than a patch, because there is one field and its new value is the
 * whole of what changed. What comes back is what was stored — the server trims — so the cache is
 * seeded from the reply rather than from what was sent, and a box that had trailing whitespace in it
 * settles to what the database actually holds.
 */
export function saveInstructionsMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (instructions: string): Promise<string> =>
      client("/api/settings/instructions", "instructions", {
        method: "PUT",
        body: { instructions },
        fallback: "Your standing instructions could not be saved",
      }),
    onSuccess: (saved) =>
      queryClient.setQueryData(settingsKeys.instructions(), saved),
  });
}
