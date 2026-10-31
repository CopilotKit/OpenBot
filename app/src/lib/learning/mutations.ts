import type { LearningSharingMode } from "@openbot/shared/learning";
import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { client } from "@/lib/client";
import { learningKeys } from "./queries";

const FALLBACK = "Couldn't save your Learning settings. Try again.";

/** Who else's Bots use your Skills: only yours, everyone's, or the ones you open. */
export function setLearningSharingModeMutationOptions(
  queryClient: QueryClient,
) {
  return mutationOptions({
    mutationFn: async (mode: LearningSharingMode): Promise<void> => {
      await client("/api/settings/learning/mode", {
        method: "PUT",
        body: { mode },
        fallback: FALLBACK,
      });
    },
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: learningKeys.personal }),
  });
}

/** Opens one of your Skills to every Bot, or closes it again. */
export function setLearnedSkillOpenMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (variables: {
      name: string;
      open: boolean;
    }): Promise<void> => {
      await client(
        `/api/settings/learning/skills/${encodeURIComponent(variables.name)}`,
        { method: "PUT", body: { open: variables.open }, fallback: FALLBACK },
      );
    },
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: learningKeys.personal }),
  });
}
