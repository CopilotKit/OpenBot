import { queryOptions } from "@tanstack/react-query";
import { client } from "@/lib/client";
import type {
  LearningDeliveryStatus,
  LearningOverview,
  LearningSettings,
} from "../../../../shared/learning";

export const learningKeys = {
  all: ["learning"] as const,
  settings: ["learning", "settings"] as const,
};
export function learningSettingsQueryOptions() {
  return queryOptions({
    queryKey: learningKeys.settings,
    queryFn: (): Promise<LearningSettings> =>
      client("/api/admin/learning/settings", "settings", {
        fallback: "Learning settings could not be loaded.",
      }),
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
export function saveLearningSettings(
  settings: LearningSettings,
): Promise<LearningSettings> {
  return client("/api/admin/learning/settings", "settings", {
    method: "PUT",
    body: settings,
    fallback: "Learning settings could not be saved.",
  });
}
