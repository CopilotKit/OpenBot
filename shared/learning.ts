/** Server-owned Automatic Learning configuration; contains no credentials. */
export type LearningTarget = { containerId: string; revision?: string };
export type LearningSettings = {
  enabled: boolean;
  defaultTarget: LearningTarget | null;
  /** Missing inherits the default; null explicitly excludes this Bot. */
  agents: Record<string, LearningTarget | null>;
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

/** A small projection of Inspector: evidence and credentials stay in Intelligence. */
export type LearningOverview = {
  configuration:
    | "not_configured"
    | "invalid"
    | "configured"
    | "selection_required";
  container?: { id: string; name: string };
  pendingThreadCount: number;
  pendingCandidateCount: number;
  publishedSkillCount: number;
  insightCount: number;
  hasActiveRun: boolean;
  latestRunStatus: string | null;
  links: { learning: string; candidates: string | null; runs: string | null };
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
 * - `unavailable`: Intelligence could not be asked; it is tried again.
 * - `pending`: not asked yet.
 */
export type LearningAutoAssignState =
  | { state: "off" | "saved" | "not_entitled" | "unavailable" | "pending" }
  | { state: "assigned"; containerId: string }
  | {
      state: "absent";
      containerId: string;
      /** Exactly what an operator runs to create it, for the Intelligence this deployment uses. */
      instructions?: string;
      /** Whether this deployment holds a credential that can create it (Admin's "Create it now"). */
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

/** A learned Skill's name as Intelligence publishes it: 1 to 200 characters, no slash and no control characters. */
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
