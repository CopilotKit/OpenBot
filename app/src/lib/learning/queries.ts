import type {
  LearnedSkillContent,
  LearningAutoAssignState,
  LearningDeliveryStatus,
  LearningOverview,
  LearningProposal,
  LearningProposalDetail,
  LearningRunSummary,
  LearningSettings,
  PersonalLearningSharing,
  PersonalReview,
} from "@openbot/shared/learning";
import { queryOptions } from "@tanstack/react-query";
import { client } from "@/lib/client";

export const learningKeys = {
  all: ["learning"] as const,
  settings: ["learning", "settings"] as const,
  automatic: ["learning", "automatic"] as const,
  personal: ["learning", "personal"] as const,
  proposals: (agentId?: string) =>
    ["learning", "proposals", { agentId: agentId ?? null }] as const,
  proposal: (proposalId: string, agentId?: string) =>
    ["learning", "proposal", { proposalId, agentId: agentId ?? null }] as const,
  runs: (agentId?: string) =>
    ["learning", "runs", { agentId: agentId ?? null }] as const,
  skills: (agentId?: string) =>
    ["learning", "skills", { agentId: agentId ?? null }] as const,
  skill: (source: LearnedSkillSource, name: string) =>
    ["learning", "skill", { source, name }] as const,
};

/** `?agentId=…` for a Bot's own container, nothing for the deployment default. */
const forBot = (agentId?: string) =>
  agentId ? `?agentId=${encodeURIComponent(agentId)}` : "";
/**
 * Settings, Learning: who else's Bots use the Skills learned from your own recordings, and the Skills in your own
 * Learning space (null when Intelligence did not deliver them).
 */
export function personalLearningQueryOptions() {
  return queryOptions({
    queryKey: learningKeys.personal,
    retry: false,
    queryFn: async (): Promise<PersonalLearningSharing> =>
      (
        await client("/api/settings/learning", {
          fallback: "Couldn't load your Learning settings. Reload the page.",
        })
      ).json(),
  });
}
export function learningSettingsQueryOptions() {
  return queryOptions({
    queryKey: learningKeys.settings,
    queryFn: (): Promise<LearningSettings> =>
      client("/api/admin/learning/settings", "settings", {
        fallback: "Learning settings could not be loaded.",
      }),
  });
}
/** Why no container was assigned automatically, or `null` when the server has nothing to say. */
export function learningAutomaticQueryOptions() {
  return queryOptions({
    queryKey: learningKeys.automatic,
    retry: false,
    queryFn: async (): Promise<LearningAutoAssignState | null> =>
      (await client<LearningAutoAssignState | undefined>(
        "/api/admin/learning/settings",
        "automatic",
        { fallback: "Learning settings could not be loaded." },
      )) ?? null,
  });
}
export function learningOverviewQueryOptions(agentId?: string) {
  return queryOptions({
    queryKey: ["learning", "overview", agentId],
    retry: false,
    queryFn: (): Promise<LearningOverview> =>
      client(
        `/api/admin/learning/overview${agentId ? `?agentId=${encodeURIComponent(agentId)}` : ""}`,
        "overview",
        { fallback: "Learning status could not be loaded." },
      ),
  });
}
export function learningDeliveryQueryOptions(agentId: string) {
  return queryOptions({
    queryKey: ["learning", "delivery", agentId],
    enabled: Boolean(agentId),
    retry: false,
    queryFn: (): Promise<LearningDeliveryStatus> =>
      client(
        `/api/admin/learning/status/${encodeURIComponent(agentId)}`,
        "status",
        { fallback: "Skill delivery status could not be loaded." },
      ),
  });
}
/** Create the project's container with the deployment's credential, then report what assignment found. */
export function createLearningContainer(): Promise<LearningAutoAssignState> {
  return client("/api/admin/learning/container", "automatic", {
    method: "POST",
    body: {},
    fallback: "The Learning container could not be created.",
  });
}
export function saveLearningSettings(
  settings: LearningSettings,
): Promise<LearningSettings> {
  return client("/api/admin/learning/settings", "settings", {
    method: "PUT",
    body: settings,
    fallback: "Learning settings could not be saved.",
  });
}

/** The container a proposal list is for, and its proposed skills, newest first, reviewed ones included. */
export type LearningProposals = {
  containerId: string | null;
  proposals: LearningProposal[];
};

/** Admin → Automatic learning: the skills Intelligence proposed for a Bot's container, or the default. */
export function learningProposalsQueryOptions(agentId?: string) {
  return queryOptions({
    queryKey: learningKeys.proposals(agentId),
    retry: false,
    queryFn: async (): Promise<LearningProposals> =>
      (
        await client(`/api/admin/learning/proposals${forBot(agentId)}`, {
          fallback: "Couldn't load proposed skills. Try again.",
        })
      ).json(),
  });
}

/** One proposed skill with every file it publishes and the evidence behind it. */
export function learningProposalQueryOptions(
  proposalId: string,
  agentId?: string,
) {
  return queryOptions({
    queryKey: learningKeys.proposal(proposalId, agentId),
    retry: false,
    queryFn: (): Promise<LearningProposalDetail> =>
      client(
        `/api/admin/learning/proposals/${encodeURIComponent(proposalId)}${forBot(agentId)}`,
        "proposal",
        { fallback: "Couldn't load this skill. Try again." },
      ),
  });
}

/** The analysis runs of a Bot's container, or the default, newest first. */
export function learningRunsQueryOptions(agentId?: string) {
  return queryOptions({
    queryKey: learningKeys.runs(agentId),
    retry: false,
    queryFn: async (): Promise<{
      containerId: string | null;
      runs: LearningRunSummary[];
    }> =>
      (
        await client(`/api/admin/learning/runs${forBot(agentId)}`, {
          fallback: "Couldn't load analysis runs. Try again.",
        })
      ).json(),
  });
}

/** The skills published in a Bot's container, or the default. */
export function learnedSkillsQueryOptions(agentId?: string) {
  return queryOptions({
    queryKey: learningKeys.skills(agentId),
    retry: false,
    queryFn: async (): Promise<{
      containerId: string | null;
      skills: { name: string; description: string }[];
    }> =>
      (
        await client(`/api/admin/learning/skills${forBot(agentId)}`, {
          fallback: "Couldn't load published skills. Try again.",
        })
      ).json(),
  });
}

/** Whose published skill is being read: an admin's container, your own, or one person's. */
export type LearnedSkillSource =
  | { kind: "admin"; agentId?: string }
  | { kind: "personal" }
  | { kind: "person"; userId: string };

function learnedSkillPath(source: LearnedSkillSource, name: string) {
  const skill = encodeURIComponent(name);
  switch (source.kind) {
    case "admin":
      return `/api/admin/learning/skills/${skill}${forBot(source.agentId)}`;
    case "personal":
      return `/api/settings/learning/skills/${skill}`;
    case "person":
      return `/api/admin/learning/people/${encodeURIComponent(source.userId)}/skills/${skill}`;
  }
}

/** One published skill with every file it contains. */
export function learnedSkillQueryOptions(
  source: LearnedSkillSource,
  name: string,
) {
  return queryOptions({
    queryKey: learningKeys.skill(source, name),
    retry: false,
    queryFn: (): Promise<LearnedSkillContent> =>
      client(learnedSkillPath(source, name), "skill", {
        fallback: "Couldn't load this skill. Try again.",
      }),
  });
}

/** Settings, Learning: the skills proposed from your own recordings that wait for your decision. */
export function personalReviewQueryOptions() {
  return queryOptions({
    queryKey: ["learning", "review"] as const,
    retry: false,
    queryFn: async (): Promise<PersonalReview> =>
      (
        await client("/api/settings/learning/review", {
          fallback: "Couldn't load your skills to review. Reload the page.",
        })
      ).json(),
  });
}

/** One skill proposed from your own recordings, with every file it publishes. */
export function personalProposalQueryOptions(
  container: string,
  proposalId: string,
) {
  return queryOptions({
    queryKey: [
      "learning",
      "personal-proposal",
      { container, proposalId },
    ] as const,
    retry: false,
    queryFn: (): Promise<LearningProposalDetail> =>
      client(
        `/api/settings/learning/proposals/${encodeURIComponent(proposalId)}?container=${encodeURIComponent(container)}`,
        "proposal",
        { fallback: "Couldn't load this skill. Try again." },
      ),
  });
}
