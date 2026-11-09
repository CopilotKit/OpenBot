/** Server-owned Automatic Learning configuration; contains no credentials. */
export type LearningTarget = { containerId: string; revision?: string };
export type LearningSettings = {
  enabled: boolean;
  defaultTarget: LearningTarget | null;
  /** Missing inherits the default; null explicitly excludes this Bot. */
  agents: Record<string, LearningTarget | null>;
  /** Who reviews what a person's own Learning space proposes. Missing means "admins". */
  personalReview?: LearningPersonalReview;
  /** Whether proposals are approved without a review. Only the personal edition reads it; there, missing means true. */
  autoApprove?: boolean;
};

export type LearningDeliveryStatus = {
  configured: boolean;
  containerId?: string;
  revision?: string;
  initialized: boolean;
  stale: boolean;
  lastCheckedAt?: string;
  error?: { code: string; message: string; retryable: boolean };
};

/**
 * A small projection of Inspector: evidence and credentials stay in Intelligence.
 *
 * Read from Intelligence's Inspector panel where it serves one. An Intelligence with no dashboard
 * serves none, and the same answer is read from the project key's own Learning routes, which do
 * not count waiting conversations, published Skills or Insights: those are null then, and so is
 * every link, since there is no dashboard to link to.
 */
export type LearningOverview = {
  configuration:
    | "not_configured"
    | "invalid"
    | "configured"
    | "selection_required";
  container?: { id: string; name: string };
  pendingThreadCount: number | null;
  pendingCandidateCount: number;
  publishedSkillCount: number | null;
  insightCount: number | null;
  hasActiveRun: boolean;
  latestRunStatus: string | null;
  links: {
    learning: string | null;
    candidates: string | null;
    runs: string | null;
  };
  /** Why Learning can't run on this machine's model, and what to do. Absent when it can. */
  modelProblem?: string;
};

/** A Skill change Intelligence proposed, as Admin → Automatic learning and Settings → Learning list it. */
export type LearningProposal = {
  id: string;
  title: string;
  description: string;
  /** Why Intelligence proposes it. */
  reason: string;
  operation: "add" | "update" | "remove";
  status: "pending_review" | "approved" | "rejected";
  createdAt: string;
  reviewedAt: string | null;
};

/** One piece of what a proposal was learned from: a conversation's cited messages, or a recording. */
export type LearningEvidence =
  | {
      kind: "conversation";
      /** Intelligence's id for the conversation. */
      id: string;
      title: string | null;
      /** False when the conversation is gone or could not be read. */
      available: boolean;
      messages: {
        id: string;
        role: "user" | "assistant" | "tool";
        content: string;
      }[];
    }
  | {
      kind: "recording";
      /** Intelligence's id for the recording. */
      id: string;
      /** The recording's title, or null when it has none or could not be read. */
      title: string | null;
      available: boolean;
      eventCount: number;
      /** The names of the cited events, in order. */
      events: string[];
    };

/** Everything a person needs to decide on a proposal: the files it publishes and why. */
export type LearningProposalDetail = LearningProposal & {
  /** Every file the Skill would publish. SKILL.md first. */
  files: { path: string; content: string }[];
  /** The Insights behind it, each with its evidence, or null where that could not be read. */
  insights: {
    id: string;
    statement: string;
    impact: string;
    evidence: LearningEvidence[] | null;
  }[];
};

/**
 * The container OpenBot assigns on its own when nobody has chosen one.
 *
 * The same ID `scripts/setup-learning.ts` creates, so a project set up by that helper, by hand in
 * Intelligence, or by `copilotkit learning containers create --id openbot` is found the same way.
 */
export const AUTOMATIC_LEARNING_CONTAINER_ID = "openbot";

/**
 * What automatic container assignment last found, for the Admin page.
 *
 * - `off`: the operator switched it off, or the environment already names a container.
 * - `saved`: an administrator's saved settings decide, so nothing is assigned automatically.
 * - `assigned`: this process assigned the container.
 * - `absent`: this Intelligence project has no such container yet.
 * - `not_entitled`: the project's plan does not include Learning.
 * - `learning_off`: Intelligence answered, and has Learning switched off: its Learning routes are not
 *   there at all. Not the same as `unavailable`, which is Intelligence not answering.
 * - `unavailable`: Intelligence could not be asked; it is tried again.
 * - `pending`: not asked yet.
 */
export type LearningAutoAssignState =
  | {
      state:
        | "off"
        | "saved"
        | "not_entitled"
        | "learning_off"
        | "unavailable"
        | "pending";
    }
  | { state: "assigned"; containerId: string }
  | {
      state: "absent";
      containerId: string;
      /** Exactly what an operator runs to create it, for the Intelligence this deployment uses. */
      instructions?: string;
      /** Whether this deployment holds a credential that can create it (Admin's Create the <id> container button). */
      canCreate?: boolean;
      /** Why the last attempt with that credential failed. */
      createError?: string;
    };

export const LEARNING_CONTAINER_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export function isLearningContainerId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 64 &&
    LEARNING_CONTAINER_ID.test(value)
  );
}

/**
 * Who else's Bots use the Skills learned in a person's own Learning space. `closed`, the default: only their own Bots.
 * `open`: every Bot in this OpenBot. `choose`: every Bot, for the Skills the person opens one by one.
 */
export const LEARNING_SHARING_MODES = ["closed", "open", "choose"] as const;
export type LearningSharingMode = (typeof LEARNING_SHARING_MODES)[number];
export function isLearningSharingMode(
  value: unknown,
): value is LearningSharingMode {
  return (
    typeof value === "string" &&
    (LEARNING_SHARING_MODES as readonly string[]).includes(value)
  );
}

/** Who reviews what a person's own Learning space proposes: the administrators, or the people themselves. */
export const LEARNING_PERSONAL_REVIEW = ["admins", "people"] as const;
export type LearningPersonalReview = (typeof LEARNING_PERSONAL_REVIEW)[number];
export function isLearningPersonalReview(
  value: unknown,
): value is LearningPersonalReview {
  return (
    typeof value === "string" &&
    (LEARNING_PERSONAL_REVIEW as readonly string[]).includes(value)
  );
}

/** A learned Skill's name as Intelligence publishes it, a safe single path segment: 1 to 200 UTF-16 units, no slash or backslash, no control characters, not "." or "..", and no leading or trailing whitespace. */
export function isLearnedSkillName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 200 &&
    value.trim() === value &&
    value !== "." &&
    value !== ".." &&
    !value.includes("/") &&
    !value.includes("\\") &&
    ![...value].some(
      (character) =>
        character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  );
}

/** One Skill published in the person's own Learning space, and whether they opened it to every Bot (under `choose`). */
export type PersonalLearnedSkill = {
  name: string;
  description: string;
  open: boolean;
  /** Who approved it into the space; null when no approval is on record, which counts as an administrator's; also always null for skills from a Bot's conversations, which keep no record. */
  approvedBy: "person" | "admin" | null;
  /** Where the person's request to share it with every Bot stands; "none" when there is no record. */
  sharing: "none" | "requested" | "approved" | "declined";
};

/** Settings, Learning: the person's sharing choice and the Skills in their own space. */
export type PersonalLearningSharing = {
  mode: LearningSharingMode;
  /** Whether an administrator lets people open their Skills to every Bot. While it is false only `closed` takes effect:
   * a choice made before stays saved, and applies again once it is true. */
  sharingAllowed: boolean;
  /** The Skills published in the person's own space, read the way a run reads them (none yet is an empty list), or null
   * when they could not be read, and then `unavailable` says why. */
  skills: PersonalLearnedSkill[] | null;
  /** `off`: Automatic Learning is off in this OpenBot. `unavailable`: Intelligence did not deliver them (its Learning
   * delivery is off, the space does not exist yet, or it could not be reached). */
  unavailable?: "off" | "unavailable";
};

/** One run of Learning over a container, as the Learning screens list it. */
export type LearningRunSummary = {
  id: string;
  status:
    | "queued"
    | "freezing"
    | "batching"
    | "reducing"
    | "finalizing"
    | "succeeded"
    | "failed";
  trigger: "automatic" | "manual";
  proposals: number | null;
  insights: number | null;
  failureCode: string | null;
  /** Why a failed run stopped, said for the person, with what to do. Null or absent unless it failed. */
  failure?: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
};

/** A learned Skill's files. SKILL.md first; `text` is null for a binary file. */
export type LearnedSkillContent = {
  name: string;
  description: string;
  files: { path: string; text: string | null }[];
};

/** A recording of the person's own that a published Skill was learned from. */
export type LearnedSkillRecording = {
  /** Intelligence's id for the recording (its trajectory). */
  id: string;
  /** The recording's title, or null when it has none or it could not be read. */
  title: string | null;
  /** False when Intelligence no longer has the recording. */
  available: boolean;
};

/**
 * One published Skill as Settings, Learning opens it. `recordings` names the person's own recordings it was learned
 * from, read through the proposals Intelligence published it from; absent where that could not be read or does not
 * apply (a skill learned from conversations, or an admin's view).
 */
export type LearnedSkillDetail = LearnedSkillContent & {
  recordings?: LearnedSkillRecording[];
};

/** Where a person's Learning comes from: a container of recordings or of conversations. */
export type LearningSource = {
  containerId: string;
  kind: "recordings" | "conversations";
  label: string;
};

/** The person's own review of what their sources proposed. `proposals` and `latestRun` are null when they could not be read. */
export type PersonalReview = {
  canReview: boolean;
  /** Null outside the personal edition, where there is no automatic approval. */
  autoApprove: boolean | null;
  /**
   * How many proposals opening the page approved automatically; 0 when no sweep ran, as in the team edition. The server
   * always sends it; optional so a reader written before it still type-checks.
   */
  approved?: number;
  /**
   * Why Learning can't run on this machine at all, in a sentence for the person (OpenBot Desktop signed in with a model
   * Learning can't use). Absent when nothing is known to be wrong.
   */
  modelProblem?: string;
  sources: (LearningSource & {
    proposals: LearningProposal[] | null;
    latestRun: LearningRunSummary | null;
    /** Set when Learning is switched off in Intelligence (or, for now, not in its licence), so there is nothing to read. */
    unavailable?: "learning-off";
  })[];
};

/**
 * The skills Learning proposed from one of the person's recordings, newest first: each proposal made since the
 * recording stopped whose evidence cites a recording of theirs by that name. Rejected proposals and removals are left
 * out. `container` is the Learning space it is in, for opening or reviewing it.
 */
export type RecordingSkills = {
  skills: (LearningProposal & { container: string })[];
};

/** What an administrator reviews for each person, where people's Learning is reviewed by admins. */
export type PeopleProposals = {
  people: {
    userId: string;
    name: string;
    proposals: LearningProposal[] | null;
  }[];
};

/** A person's request to open a learned Skill to every Bot. */
export type SharingRequest = {
  userId: string;
  name: string;
  skillName: string;
  requestedAt: string;
};
