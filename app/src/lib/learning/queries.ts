import {
  AUTOMATIC_LEARNING_CONTAINER_ID,
  type LearnedSkillDetail,
  type LearningAutoAssignState,
  type LearningProposalDetail,
} from "@openbot/shared/learning";
import { queryOptions } from "@tanstack/react-query";
import {
  getBotLearningStatus,
  getLearnedSkill,
  getLearningEvidence,
  getLearningOverview,
  getLearningProposal,
  getLearningSettings,
  getPersonLearningEvidence,
  getPersonLearningProposal,
  getPersonLearningReview,
  getPersonLearningSettings,
  getPublishedSkill,
  getRecordingTitles,
  listLearningProposals,
  listOrganizationLearningRuns,
  listPersonalLearningProposals,
  listPersonLearningProposals,
  listPublishedSkills,
  listSkillSharingRequests,
} from "@/lib/api/generated/learning/learning";
import type {
  LearningOverview as ApiLearningOverview,
  LearningProposal as ApiLearningProposal,
  LearningSettings as ApiLearningSettings,
  LearningAutomatic,
  LearningConfiguration,
  LearningPerson,
  LearningRun,
  PersonLearning,
  PersonLearningReview,
  PublishedSkillSummary,
  SkillDelivery,
  SkillSharingRequest,
} from "@/lib/api/generated/model";
import { ORGANIZATION_ID } from "@/lib/api/request";
import { everyPage } from "@/lib/routines/queries";
import { assembleProposal } from "./proposal-detail";

/** The person signed in, as the API addresses them. */
const ME = "me";

/** A skill change Learning proposed in a space, waiting for review or reviewed. */
export type LearningProposal = ApiLearningProposal;
/** Which space every Bot learns into, which space each Bot has, and who reviews what people's recordings propose. */
export type LearningSettings = ApiLearningSettings;
/** How Learning stands for a space: what waits, what is published, and whether a run is going. */
export type LearningOverview = ApiLearningOverview;
/** How a Bot's learned skills reach it. */
export type LearningDeliveryStatus = SkillDelivery;
/** One run of Learning over a space, with OpenBot's sentence for why it stopped when it failed. */
export type LearningRunSummary = LearningRun;
/** Settings, Learning: the person's sharing choice and the skills in their own space. */
export type PersonalLearningSharing = PersonLearning;
/** The person's own review of what each of their spaces proposed, with each space's latest run. */
export type PersonalReview = PersonLearningReview;
/** A person whose recordings proposed skills, with their space and what waits in it. */
export type PeopleProposalsPerson = LearningPerson;
/** A person's request to open a learned skill to every Bot, by the id an admin decides it with. */
export type SharingRequest = SkillSharingRequest;

export const learningKeys = {
  all: ["learning"] as const,
  settings: ["learning", "settings"] as const,
  automatic: ["learning", "automatic"] as const,
  personal: ["learning", "personal"] as const,
  review: ["learning", "review"] as const,
  peopleProposals: ["learning", "people-proposals"] as const,
  sharingRequests: ["learning", "sharing-requests"] as const,
  personProposal: (userId: string, containerId: string, proposalId: string) =>
    [
      "learning",
      "person-proposal",
      { userId, containerId, proposalId },
    ] as const,
  recordingSkills: (title: string, since: number, revision: string) =>
    ["learning", "recording-skills", { title, since, revision }] as const,
  personalProposal: (container: string, proposalId: string) =>
    ["learning", "personal-proposal", { container, proposalId }] as const,
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

/** `{ botId }` for a Bot's own space, nothing for the space every Bot learns into. */
const forBot = (agentId?: string) => (agentId ? { botId: agentId } : {});

/**
 * Settings, Learning: who else's Bots use the Skills learned from your own recordings, and the Skills in your own
 * Learning space (null when Intelligence did not deliver them).
 */
export function personalLearningQueryOptions() {
  return queryOptions({
    queryKey: learningKeys.personal,
    retry: false,
    queryFn: ({ signal }): Promise<PersonalLearningSharing> =>
      getPersonLearningSettings(ORGANIZATION_ID, ME, {
        signal,
        fallback: "Couldn't load your Learning settings. Reload the page.",
      }),
  });
}

function readLearningConfiguration(
  signal?: AbortSignal,
): Promise<LearningConfiguration> {
  return getLearningSettings(ORGANIZATION_ID, {
    signal,
    fallback: "Learning settings could not be loaded.",
  });
}

export function learningSettingsQueryOptions() {
  return queryOptions({
    queryKey: learningKeys.settings,
    queryFn: async ({ signal }): Promise<LearningSettings> =>
      (await readLearningConfiguration(signal)).settings,
  });
}

/**
 * What OpenBot last found looking for the space it assigns by itself, as the Admin page words it. The space it assigns
 * is always the same one, so an answer that leaves out which is about that one.
 */
export function autoAssignState(
  automatic: LearningAutomatic | null,
): LearningAutoAssignState | null {
  if (!automatic) return null;
  const containerId = automatic.containerId ?? AUTOMATIC_LEARNING_CONTAINER_ID;
  if (automatic.state === "assigned") return { state: "assigned", containerId };
  if (automatic.state === "absent")
    return {
      state: "absent",
      containerId,
      ...(automatic.instructions !== undefined
        ? { instructions: automatic.instructions }
        : {}),
      ...(automatic.canCreate !== undefined
        ? { canCreate: automatic.canCreate }
        : {}),
      ...(automatic.createError !== undefined
        ? { createError: automatic.createError }
        : {}),
    };
  return { state: automatic.state };
}

/** Why no container was assigned automatically, or `null` when the server has nothing to say. */
export function learningAutomaticQueryOptions() {
  return queryOptions({
    queryKey: learningKeys.automatic,
    retry: false,
    queryFn: async ({ signal }): Promise<LearningAutoAssignState | null> =>
      autoAssignState((await readLearningConfiguration(signal)).automatic),
  });
}

export function learningOverviewQueryOptions(agentId?: string) {
  return queryOptions({
    queryKey: ["learning", "overview", agentId],
    retry: false,
    queryFn: ({ signal }): Promise<LearningOverview> =>
      getLearningOverview(ORGANIZATION_ID, forBot(agentId), {
        signal,
        fallback: "Learning status could not be loaded.",
      }),
  });
}

export function learningDeliveryQueryOptions(agentId: string) {
  return queryOptions({
    queryKey: ["learning", "delivery", agentId],
    enabled: Boolean(agentId),
    retry: false,
    queryFn: ({ signal }): Promise<LearningDeliveryStatus> =>
      getBotLearningStatus(ORGANIZATION_ID, agentId, {
        signal,
        fallback: "Skill delivery status could not be loaded.",
      }),
  });
}

/**
 * The space a Bot learns into, or the one every Bot does, by the saved settings: a Bot named there has its own (null
 * leaves it out of Learning), any other uses the default. Null where none is assigned.
 */
async function spaceFor(
  agentId: string | undefined,
  signal?: AbortSignal,
): Promise<string | null> {
  const { settings } = await readLearningConfiguration(signal);
  const target =
    agentId && Object.hasOwn(settings.bots, agentId)
      ? (settings.bots[agentId] ?? null)
      : settings.defaultTarget;
  return target?.containerId ?? null;
}

/** The container a proposal list is for, and its proposed skills, newest first, reviewed ones included. */
export type LearningProposals = {
  containerId: string | null;
  proposals: LearningProposal[];
};

/** Admin → Automatic learning: the skills Learning proposed for a Bot's space, or the default. */
export function learningProposalsQueryOptions(agentId?: string) {
  return queryOptions({
    queryKey: learningKeys.proposals(agentId),
    retry: false,
    queryFn: async ({ signal }): Promise<LearningProposals> => {
      const [containerId, proposals] = await Promise.all([
        spaceFor(agentId, signal),
        everyPage(async (params) => {
          const page = await listLearningProposals(
            ORGANIZATION_ID,
            { ...forBot(agentId), ...params },
            { signal, fallback: "Couldn't load proposed skills. Try again." },
          );
          return { items: page.proposals, nextCursor: page.nextCursor };
        }),
      ]);
      return { containerId, proposals };
    },
  });
}

const PROPOSAL_FALLBACK = "Couldn't load this skill. Try again.";

/** One proposed skill in a Bot's space, or the default, with every file it publishes and the evidence behind it. */
export function learningProposalQueryOptions(
  proposalId: string,
  agentId?: string,
) {
  return queryOptions({
    queryKey: learningKeys.proposal(proposalId, agentId),
    retry: false,
    queryFn: async ({ signal }): Promise<LearningProposalDetail> =>
      assembleProposal(
        await getLearningProposal(
          ORGANIZATION_ID,
          proposalId,
          forBot(agentId),
          { signal, fallback: PROPOSAL_FALLBACK },
        ),
        {
          evidence: (insightId) =>
            getLearningEvidence(ORGANIZATION_ID, insightId, forBot(agentId), {
              signal,
            }),
        },
      ),
  });
}

/** The analysis runs of a Bot's space, or the default, newest first. */
export function learningRunsQueryOptions(agentId?: string) {
  return queryOptions({
    queryKey: learningKeys.runs(agentId),
    retry: false,
    queryFn: async ({
      signal,
    }): Promise<{ containerId: string | null; runs: LearningRunSummary[] }> => {
      const [containerId, runs] = await Promise.all([
        spaceFor(agentId, signal),
        everyPage(async (params) => {
          const page = await listOrganizationLearningRuns(
            ORGANIZATION_ID,
            { ...forBot(agentId), ...params },
            { signal, fallback: "Couldn't load analysis runs. Try again." },
          );
          return { items: page.runs, nextCursor: page.nextCursor };
        }),
      ]);
      return { containerId, runs };
    },
  });
}

/** The skills published in a Bot's space, or the default, read to the end of the list. */
export function learnedSkillsQueryOptions(agentId?: string) {
  return queryOptions({
    queryKey: learningKeys.skills(agentId),
    retry: false,
    queryFn: async ({
      signal,
    }): Promise<{
      containerId: string | null;
      skills: PublishedSkillSummary[];
    }> => {
      // Every page names the same space; the first one says which.
      let containerId: string | null | undefined;
      const skills = await everyPage(async (params) => {
        const page = await listPublishedSkills(
          ORGANIZATION_ID,
          { ...forBot(agentId), ...params },
          { signal, fallback: "Couldn't load published skills. Try again." },
        );
        containerId ??= page.containerId;
        return { items: page.skills, nextCursor: page.nextCursor };
      });
      return { containerId: containerId ?? null, skills };
    },
  });
}

/** Whose published skill is being read: an admin's container, your own, or one person's. */
export type LearnedSkillSource =
  | { kind: "admin"; agentId?: string }
  | { kind: "personal" }
  | { kind: "person"; userId: string };

/** One published skill with every file it contains and, from your own space, the recordings it was learned from. */
export function learnedSkillQueryOptions(
  source: LearnedSkillSource,
  name: string,
) {
  return queryOptions({
    queryKey: learningKeys.skill(source, name),
    retry: false,
    queryFn: ({ signal }): Promise<LearnedSkillDetail> => {
      const options = {
        signal,
        fallback: "Couldn't load this skill. Try again.",
      };
      switch (source.kind) {
        case "admin":
          return getPublishedSkill(
            ORGANIZATION_ID,
            name,
            forBot(source.agentId),
            options,
          );
        case "personal":
          return getLearnedSkill(ORGANIZATION_ID, ME, name, options);
        case "person":
          return getLearnedSkill(ORGANIZATION_ID, source.userId, name, options);
      }
    },
  });
}

/** Settings, Learning: the skills proposed from your own recordings that wait for your decision. */
export function personalReviewQueryOptions() {
  return queryOptions({
    queryKey: learningKeys.review,
    retry: false,
    queryFn: ({ signal }): Promise<PersonalReview> =>
      getPersonLearningReview(ORGANIZATION_ID, ME, {
        signal,
        fallback: "Couldn't load your skills to review. Reload the page.",
      }),
    // While a run is going the review is read again, so what it proposes (or approves) shows up without a reload.
    refetchInterval: (query) =>
      query.state.data?.spaces.some(
        (space) =>
          space.latestRun &&
          !["succeeded", "failed"].includes(space.latestRun.status),
      )
        ? 10_000
        : false,
  });
}

/**
 * One proposal in a person's own space, assembled for the dialog, with the recordings its evidence cites named as that
 * person's. `personId` is `me` for your own.
 */
function personProposal(
  personId: string,
  containerId: string,
  proposalId: string,
  signal: AbortSignal,
): Promise<LearningProposalDetail> {
  const space = { containerId };
  return getPersonLearningProposal(
    ORGANIZATION_ID,
    personId,
    proposalId,
    space,
    { signal, fallback: PROPOSAL_FALLBACK },
  ).then((proposal) =>
    assembleProposal(proposal, {
      evidence: (insightId) =>
        getPersonLearningEvidence(ORGANIZATION_ID, personId, insightId, space, {
          signal,
        }),
      titles: (ids) =>
        getRecordingTitles(ORGANIZATION_ID, personId, { ids }, { signal }),
    }),
  );
}

/** One skill proposed from your own recordings, with every file it publishes. */
export function personalProposalQueryOptions(
  container: string,
  proposalId: string,
) {
  return queryOptions({
    queryKey: learningKeys.personalProposal(container, proposalId),
    retry: false,
    queryFn: ({ signal }): Promise<LearningProposalDetail> =>
      personProposal(ME, container, proposalId, signal),
  });
}

/** Admin → Learning, People: the skills proposed from each person's own recordings. */
export function peopleProposalsQueryOptions() {
  return queryOptions({
    queryKey: learningKeys.peopleProposals,
    retry: false,
    queryFn: async ({
      signal,
    }): Promise<{ people: PeopleProposalsPerson[] }> => ({
      people: await everyPage(async (params) => {
        const page = await listPersonalLearningProposals(
          ORGANIZATION_ID,
          params,
          {
            signal,
            fallback: "Couldn't load people's skills to review. Try again.",
          },
        );
        return { items: page.people, nextCursor: page.nextCursor };
      }),
    }),
  });
}

/** One skill proposed from a person's own recordings, with every file it publishes. */
export function personProposalQueryOptions(
  userId: string,
  containerId: string,
  proposalId: string,
) {
  return queryOptions({
    queryKey: learningKeys.personProposal(userId, containerId, proposalId),
    retry: false,
    queryFn: ({ signal }): Promise<LearningProposalDetail> =>
      personProposal(userId, containerId, proposalId, signal),
  });
}

/** Admin → Learning: people's requests to open a learned skill to every Bot, waiting for an admin. */
export function sharingRequestsQueryOptions() {
  return queryOptions({
    queryKey: learningKeys.sharingRequests,
    retry: false,
    queryFn: ({ signal }): Promise<SharingRequest[]> =>
      everyPage(async (params) => {
        const page = await listSkillSharingRequests(ORGANIZATION_ID, params, {
          signal,
          fallback: "Couldn't load sharing requests. Try again.",
        });
        return { items: page.requests, nextCursor: page.nextCursor };
      }),
  });
}

/** A skill proposed from one of the person's recordings, with the space it is in, for opening or reviewing it. */
export type RecordingSkill = LearningProposal & { container: string };

/**
 * Teach a Bot, after a recording saves: the skills Learning proposed from it, named `title` and stopped at `since`
 * (milliseconds). `revision` changes whenever the person's review does (a run moves on, a proposal is approved), which
 * is when there can be something new to find.
 */
export function recordingSkillsQueryOptions(
  title: string,
  since: number,
  revision: string,
) {
  return queryOptions({
    queryKey: learningKeys.recordingSkills(title, since, revision),
    retry: false,
    queryFn: async ({ signal }): Promise<{ skills: RecordingSkill[] }> => ({
      skills: await everyPage(async (params) => {
        const page = await listPersonLearningProposals(
          ORGANIZATION_ID,
          ME,
          { recordingTitle: title, since, ...params },
          {
            signal,
            fallback: "Couldn't read your skills just now. Try again.",
          },
        );
        return {
          items: page.skills.map((skill) => ({
            ...skill.proposal,
            container: skill.containerId,
          })),
          nextCursor: page.nextCursor,
        };
      }),
    }),
  });
}
