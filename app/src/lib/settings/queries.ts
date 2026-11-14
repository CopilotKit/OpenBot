import { queryOptions } from "@tanstack/react-query";
import { getStandingInstructions } from "@/lib/api/generated/people/people";
import { ORGANIZATION_ID } from "@/lib/api/request";

/**
 * How much one person may say, in characters.
 *
 * The server owns this rule and refuses past it; this copy exists so the box can count down rather
 * than let somebody write four paragraphs and find out on save. A drift between the two therefore
 * shows up as a refusal with the server's own sentence on it, which is the safe direction for a
 * duplicated number to fail in.
 */
export const INSTRUCTIONS_LIMIT = 4000;

export const settingsKeys = {
  all: ["settings"] as const,
  instructions: () => [...settingsKeys.all, "instructions"] as const,
};

/** "" means this person has written none. There is no separate absent state to draw. */
export function instructionsQueryOptions() {
  return queryOptions({
    queryKey: settingsKeys.instructions(),
    queryFn: async ({ signal }): Promise<string> =>
      (
        await getStandingInstructions(ORGANIZATION_ID, "me", {
          signal,
          fallback: "Could not load your standing instructions",
        })
      ).instructions,
  });
}
