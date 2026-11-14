import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { updateStandingInstructions } from "@/lib/api/generated/people/people";
import { idempotencyKey, ORGANIZATION_ID } from "@/lib/api/request";
import { settingsKeys } from "./queries";

/**
 * Save, or clear by saving nothing.
 *
 * The whole text each time, because there is one field and its new value is the whole of what
 * changed. What comes back is what was stored — the server trims — so the cache is
 * seeded from the reply rather than from what was sent, and a box that had trailing whitespace in it
 * settles to what the database actually holds.
 */
export function saveInstructionsMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (instructions: string): Promise<string> =>
      (
        await updateStandingInstructions(
          ORGANIZATION_ID,
          "me",
          { instructions },
          { "Idempotency-Key": idempotencyKey() },
          { fallback: "Your standing instructions could not be saved" },
        )
      ).instructions,
    onSuccess: (saved) =>
      queryClient.setQueryData(settingsKeys.instructions(), saved),
  });
}
