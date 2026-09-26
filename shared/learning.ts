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

export const LEARNING_CONTAINER_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export function isLearningContainerId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 64 &&
    LEARNING_CONTAINER_ID.test(value)
  );
}
