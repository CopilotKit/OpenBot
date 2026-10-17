import type { CopilotKitIntelligence } from "@copilotkit/runtime/v2";
import type { LearningSettings } from "@openbot/shared/learning";
import type { LearningSpaceState } from "@openbot/shared/recorder-api";

export type LearningSpaceCheck = (
  botId: string,
  signal?: AbortSignal,
) => Promise<LearningSpaceState>;

export type LearningSpaceCheckDeps = {
  readSettings: () => Promise<LearningSettings>;
  /** The runtime key's client, for the skills read that proves a container exists. Always present: OpenBot does not start
   * without Intelligence (`server/src/config.ts`). */
  snapshots: Pick<CopilotKitIntelligence, "getLearnedSkillsSnapshot">;
  /** Default 3_000, so the whole check fits inside the runtime's 5 s selector deadline. */
  probeTimeoutMs?: number;
  /** Answers are cached per container for 60 s. */
  now?: () => number;
};

export function createLearningSpaceCheck(
  _deps: LearningSpaceCheckDeps,
): LearningSpaceCheck {
  return async () => ({ state: "unverified", containerId: null });
}
