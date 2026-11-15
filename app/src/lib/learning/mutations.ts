import type {
  LearningAutoAssignState,
  LearningPersonalReview,
  LearningSharingMode,
} from "@openbot/shared/learning";
import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import {
  approveLearningProposal,
  approvePersonLearningProposal,
  approveSkillSharing,
  createAutomaticLearningSpace,
  declineSkillSharing,
  rejectLearningProposal,
  rejectPersonLearningProposal,
  requestSkillSharing,
  startOrganizationLearningRun,
  startPersonLearningRun,
  updateLearnedSkill,
  updateLearningSettings,
  updatePersonLearningSettings,
} from "@/lib/api/generated/learning/learning";
import type {
  LearningReview,
  LearningRun,
  PersonLearningChoices,
  SkillSharingOutcomeSharing,
} from "@/lib/api/generated/model";
import { idempotencyKey, ORGANIZATION_ID } from "@/lib/api/request";
import {
  autoAssignState,
  type LearningSettings,
  learningKeys,
} from "./queries";

const FALLBACK = "Couldn't save your Learning settings. Try again.";
const DECISION_FALLBACK = "Couldn't save your decision. Try again.";
const LEARN_NOW_FALLBACK = "Couldn't start Learning. Try again.";

/** The person signed in, as the API addresses them. */
const ME = "me";

/** A new key for each write, so a retry of it is recognised as the same one. */
const once = () => ({ "Idempotency-Key": idempotencyKey() });

/** Participation, as an admin saves it: whether Learning is on, the default space and each Bot's own. */
export type LearningParticipation = Pick<
  LearningSettings,
  "enabled" | "defaultTarget" | "bots"
>;

/**
 * Save Participation. Who approves is saved from its own dialog, so it is never sent from here: a draft copied before
 * would overwrite a newer choice.
 */
export async function saveLearningSettings(
  participation: LearningParticipation,
): Promise<LearningSettings> {
  const { enabled, defaultTarget, bots } = participation;
  return (
    await updateLearningSettings(
      ORGANIZATION_ID,
      { enabled, defaultTarget, bots },
      once(),
      { fallback: "Learning settings could not be saved." },
    )
  ).settings;
}

/** Create the project's container with the deployment's credential, then report what assignment found. */
export async function createLearningContainer(): Promise<LearningAutoAssignState | null> {
  return autoAssignState(
    (
      await createAutomaticLearningSpace(ORGANIZATION_ID, once(), {
        fallback: "The Learning container could not be created.",
      })
    ).automatic,
  );
}

/** Who else's Bots use your Skills: only yours, everyone's, or the ones you open. */
export function setLearningSharingModeMutationOptions(
  queryClient: QueryClient,
) {
  return mutationOptions({
    mutationFn: (mode: LearningSharingMode): Promise<PersonLearningChoices> =>
      updatePersonLearningSettings(ORGANIZATION_ID, ME, { mode }, once(), {
        fallback: FALLBACK,
      }),
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
      await updateLearnedSkill(
        ORGANIZATION_ID,
        ME,
        variables.name,
        { open: variables.open },
        once(),
        { fallback: FALLBACK },
      );
    },
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: learningKeys.personal }),
  });
}

/** Approve a proposed skill, which publishes it to the space's Bots, or reject it. */
export function reviewLearningProposalMutationOptions(
  queryClient: QueryClient,
) {
  return mutationOptions({
    mutationFn: (variables: {
      proposalId: string;
      decision: "approve" | "reject";
      agentId?: string;
    }): Promise<LearningReview> =>
      (variables.decision === "approve"
        ? approveLearningProposal
        : rejectLearningProposal)(
        ORGANIZATION_ID,
        variables.proposalId,
        once(),
        variables.agentId ? { botId: variables.agentId } : {},
        { fallback: DECISION_FALLBACK },
      ),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: learningKeys.all }),
  });
}

/** Learn now: start a Learning run on a Bot's space, or the default, over every finished conversation. */
export function startLearningRunMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (agentId?: string): Promise<LearningRun> =>
      startOrganizationLearningRun(
        ORGANIZATION_ID,
        once(),
        agentId ? { botId: agentId } : {},
        { fallback: LEARN_NOW_FALLBACK },
      ),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: learningKeys.all }),
  });
}

/** Approve or reject a proposal in one of a person's own spaces. `personId` is `me` for your own. */
function reviewPersonProposal(variables: {
  personId: string;
  containerId: string;
  proposalId: string;
  decision: "approve" | "reject";
}): Promise<LearningReview> {
  return (
    variables.decision === "approve"
      ? approvePersonLearningProposal
      : rejectPersonLearningProposal
  )(
    ORGANIZATION_ID,
    variables.personId,
    variables.proposalId,
    once(),
    { containerId: variables.containerId },
    { fallback: DECISION_FALLBACK },
  );
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
    }): Promise<LearningReview> =>
      reviewPersonProposal({
        personId: ME,
        containerId: variables.container,
        proposalId: variables.proposalId,
        decision: variables.decision,
      }),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: learningKeys.all }),
  });
}

/** Learn now: start a Learning run over one of your own spaces. */
export function startPersonalLearningRunMutationOptions(
  queryClient: QueryClient,
) {
  return mutationOptions({
    mutationFn: (container: string): Promise<LearningRun> =>
      startPersonLearningRun(
        ORGANIZATION_ID,
        ME,
        once(),
        { containerId: container },
        { fallback: LEARN_NOW_FALLBACK },
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
      containerId: string;
      proposalId: string;
      decision: "approve" | "reject";
    }): Promise<LearningReview> =>
      reviewPersonProposal({
        personId: variables.userId,
        containerId: variables.containerId,
        proposalId: variables.proposalId,
        decision: variables.decision,
      }),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: learningKeys.all }),
  });
}

/** Ask an admin to open one of your skills to every Bot. */
export function requestSkillSharingMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (name: string): Promise<void> => {
      await requestSkillSharing(ORGANIZATION_ID, ME, name, once(), {
        fallback: "Couldn't send your request. Try again.",
      });
    },
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: learningKeys.all }),
  });
}

/** Approve or decline a person's request to open a skill to every Bot, by the request's id. */
export function decideSharingMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (variables: {
      requestId: string;
      decision: "approve" | "decline";
      requestedAt: string;
    }): Promise<SkillSharingOutcomeSharing> =>
      (
        await (variables.decision === "approve"
          ? approveSkillSharing
          : declineSkillSharing)(
          ORGANIZATION_ID,
          variables.requestId,
          { requestedAt: variables.requestedAt },
          once(),
          { fallback: DECISION_FALLBACK },
        )
      ).sharing,
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: learningKeys.all }),
    onError: () =>
      queryClient.invalidateQueries({ queryKey: learningKeys.all }),
  });
}

/** Choose who approves the skills learned from people's own recordings. */
export function savePersonalReviewMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (
      personalReview: LearningPersonalReview,
    ): Promise<LearningSettings> =>
      (
        await updateLearningSettings(
          ORGANIZATION_ID,
          { personalReview },
          once(),
          { fallback: "Couldn't save who approves. Try again." },
        )
      ).settings,
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: learningKeys.all }),
  });
}

/** Switch automatic approval of the skills learned from your own recordings on or off. */
export function saveAutoApproveMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (autoApprove: boolean): Promise<PersonLearningChoices> =>
      updatePersonLearningSettings(
        ORGANIZATION_ID,
        ME,
        { autoApprove },
        once(),
        {
          fallback: "Couldn't save automatic approval. Try again.",
        },
      ),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: learningKeys.all }),
  });
}
