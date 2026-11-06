import type {
  LearningPersonalReview,
  LearningSettings,
  LearningSharingMode,
} from "@openbot/shared/learning";
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

/** Approve a skill proposed from your own recordings, which publishes it to your Bots, or reject it. */
export function reviewPersonalProposalMutationOptions(
  queryClient: QueryClient,
) {
  return mutationOptions({
    mutationFn: (variables: {
      container: string;
      proposalId: string;
      decision: "approve" | "reject";
    }): Promise<{ id: string; status: "approved" | "rejected" }> =>
      client(
        `/api/settings/learning/proposals/${encodeURIComponent(variables.proposalId)}/${encodeURIComponent(variables.decision)}?container=${encodeURIComponent(variables.container)}`,
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

/** Learn now: start a Learning run over your own recordings. */
export function startPersonalLearningRunMutationOptions(
  queryClient: QueryClient,
) {
  return mutationOptions({
    mutationFn: (container: string): Promise<{ id: string; status: string }> =>
      client(
        `/api/settings/learning/runs?container=${encodeURIComponent(container)}`,
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

/** Approve a skill proposed from a person's own recordings, which publishes it to their Bots, or reject it. */
export function reviewPersonProposalMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (variables: {
      userId: string;
      proposalId: string;
      decision: "approve" | "reject";
    }): Promise<{ id: string; status: "approved" | "rejected" }> =>
      client(
        `/api/admin/learning/people/${encodeURIComponent(variables.userId)}/proposals/${encodeURIComponent(variables.proposalId)}/${encodeURIComponent(variables.decision)}`,
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

/** Ask an admin to open one of your skills to every Bot. */
export function requestSkillSharingMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (name: string): Promise<void> => {
      await client(
        `/api/settings/learning/skills/${encodeURIComponent(name)}/share-request`,
        {
          method: "POST",
          body: {},
          fallback: "Couldn't send your request. Try again.",
        },
      );
    },
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: learningKeys.all }),
  });
}

/** Approve or decline a person's request to open a skill to every Bot. */
export function decideSharingMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (variables: {
      userId: string;
      skillName: string;
      decision: "approve" | "decline";
      requestedAt: string;
    }): Promise<"approved" | "declined"> =>
      client(
        `/api/admin/learning/sharing-requests/${encodeURIComponent(variables.userId)}/${encodeURIComponent(variables.skillName)}/${encodeURIComponent(variables.decision)}`,
        "sharing",
        {
          method: "POST",
          body: { requestedAt: variables.requestedAt },
          fallback: "Couldn't save your decision. Try again.",
        },
      ),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: learningKeys.all }),
    onError: () =>
      queryClient.invalidateQueries({ queryKey: learningKeys.all }),
  });
}

/** Choose who approves the skills learned from people's own recordings. */
export function savePersonalReviewMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (
      personalReview: LearningPersonalReview,
    ): Promise<LearningSettings> =>
      client("/api/admin/learning/personal-review", "settings", {
        method: "PUT",
        body: { personalReview },
        fallback: "Couldn't save who approves. Try again.",
      }),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: learningKeys.all }),
  });
}

/** Switch automatic approval of the skills learned from your own recordings on or off. */
export function saveAutoApproveMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (autoApprove: boolean): Promise<{ autoApprove: boolean }> =>
      client("/api/settings/learning/auto-approve", {
        method: "PUT",
        body: { autoApprove },
        fallback: "Couldn't save automatic approval. Try again.",
      }).then((response) => response.json()),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: learningKeys.all }),
  });
}
