import type {
  LearningAutoAssignState,
  LearningDeliveryStatus,
  LearningOverview,
  LearningSettings,
  LearningTargetProblem,
  PersonalLearningSharing,
} from "@openbot/shared/learning";
import { queryOptions } from "@tanstack/react-query";
import { client } from "@/lib/client";

export const learningKeys = {
  all: ["learning"] as const,
  settings: ["learning", "settings"] as const,
  automatic: ["learning", "automatic"] as const,
  problems: ["learning", "problems"] as const,
  personal: ["learning", "personal"] as const,
};
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
/** The saved containers Intelligence won't use, or an empty list when it said nothing about them. */
export function learningProblemsQueryOptions() {
  return queryOptions({
    queryKey: learningKeys.problems,
    retry: false,
    queryFn: async (): Promise<LearningTargetProblem[]> =>
      (await client<LearningTargetProblem[] | undefined>(
        "/api/admin/learning/settings",
        "problems",
        { fallback: "Learning settings could not be loaded." },
      )) ?? [],
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
