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

/** Approve a proposed skill, which publishes it to the container's Bots, or reject it. */
export function reviewLearningProposalMutationOptions(
  queryClient: QueryClient,
) {
  return mutationOptions({
    mutationFn: (variables: {
      proposalId: string;
      decision: "approve" | "reject";
      agentId?: string;
    }): Promise<{ id: string; status: "approved" | "rejected" }> =>
      client(
        `/api/admin/learning/proposals/${encodeURIComponent(variables.proposalId)}/${variables.decision}${variables.agentId ? `?agentId=${encodeURIComponent(variables.agentId)}` : ""}`,
        "proposal",
        {
          method: "POST",
          body: {},
          fallback: "Couldn't save your decision. Try again.",
        },
      ),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: learningKeys.all }),
  });
}

/** Learn now: start a Learning run on a Bot's container, or the default, over every finished conversation. */
export function startLearningRunMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (agentId?: string): Promise<{ id: string; status: string }> =>
      client(
        `/api/admin/learning/runs${agentId ? `?agentId=${encodeURIComponent(agentId)}` : ""}`,
        "run",
        {
          method: "POST",
          body: {},
          fallback: "Couldn't start Learning. Try again.",
        },
      ),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: learningKeys.all }),
  });
}
