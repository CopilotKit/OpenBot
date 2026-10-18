import type { CopilotKitIntelligence } from "@copilotkit/runtime/v2";
import type { LearningSettings } from "@openbot/shared/learning";
import type { LearningSpaceState } from "@openbot/shared/recorder-api";
import { selectLearningTarget } from "../learning/runtime";

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

const CACHE_MS = 60_000;

/** One branch per LearnedSkillsError code (or success): the existence question only. */
export function classifyLearningSpaceProbe(
  outcome: "ok" | { code: string },
): "assigned" | "missing" | "learning-off" | "unverified" {
  if (outcome === "ok") return "assigned";
  switch (outcome.code) {
    // The container exists; nothing is published yet, or delivery is paused.
    case "REVISION_NOT_FOUND":
    case "DELIVERY_DISABLED":
    case "REVISION_REVOKED":
      return "assigned";
    case "CONTAINER_NOT_FOUND":
      return "missing";
    // Intelligence's Learning delivery is unlicensed, refused or off: existence cannot be checked.
    case "ENTITLEMENT_REQUIRED":
    case "AUTHORIZATION_FAILED":
    case "UNSUPPORTED_SERVER":
      return "learning-off";
    default:
      return "unverified";
  }
}

function errorCode(error: unknown): string {
  const code =
    error !== null && typeof error === "object" && "code" in error
      ? (error as { code: unknown }).code
      : undefined;
  return typeof code === "string" ? code : "";
}

/** Check that a Bot's Learning container exists with Intelligence. Never throws. */
export function createLearningSpaceCheck(
  deps: LearningSpaceCheckDeps,
): LearningSpaceCheck {
  const probeTimeoutMs = deps.probeTimeoutMs ?? 3_000;
  const now = deps.now ?? Date.now;
  const cache = new Map<
    string,
    { expiresAt: number; state: LearningSpaceState["state"] }
  >();

  return async (botId, signal) => {
    let containerId: string;
    try {
      const target = selectLearningTarget(await deps.readSettings(), botId);
      if (!target) return { state: "unassigned", containerId: null };
      containerId = target.containerId;
    } catch {
      return { state: "unverified", containerId: null };
    }

    const cached = cache.get(containerId);
    if (cached && cached.expiresAt > now()) {
      return { state: cached.state, containerId };
    }

    let state: LearningSpaceState["state"];
    try {
      await deps.snapshots.getLearnedSkillsSnapshot({
        containerId,
        signal: AbortSignal.any([
          signal ?? new AbortController().signal,
          AbortSignal.timeout(probeTimeoutMs),
        ]),
      });
      state = classifyLearningSpaceProbe("ok");
    } catch (error) {
      state = classifyLearningSpaceProbe({ code: errorCode(error) });
    }
    // An unverified answer is not kept: Intelligence coming back should be seen at once.
    if (state !== "unverified") {
      cache.set(containerId, { expiresAt: now() + CACHE_MS, state });
    }
    return { state, containerId };
  };
}
