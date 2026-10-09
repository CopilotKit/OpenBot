import {
  mutationOptions,
  type QueryClient,
  queryOptions,
} from "@tanstack/react-query";
import { client } from "@/lib/client";

export type ProactiveSetting = {
  id: string;
  agentId: string;
  channelId: string;
  focus: string;
  enabled: boolean;
  intervalMinutes: number;
  nextRunAt: string;
  lastRunAt: string | null;
  lastStatus: "idle" | "running" | "succeeded" | "error";
  lastError: string | null;
};
export type ProactiveSuggestion = {
  id: string;
  agentId: string;
  title: string;
  detail: string;
  sourceApp: string | null;
  sourceLink: string | null;
  createdAt: string;
};

export const proactiveKeys = {
  settings: ["proactive", "settings"] as const,
  suggestions: ["proactive", "suggestions"] as const,
};

export const proactiveSettingsQueryOptions = () =>
  queryOptions({
    queryKey: proactiveKeys.settings,
    queryFn: (): Promise<ProactiveSetting[]> =>
      client("/api/proactive/settings", "settings", {
        fallback: "Could not load background research",
      }),
    refetchInterval: 30_000,
  });
export const proactiveSuggestionsQueryOptions = () =>
  queryOptions({
    queryKey: proactiveKeys.suggestions,
    queryFn: (): Promise<ProactiveSuggestion[]> =>
      client("/api/proactive/suggestions", "suggestions", {
        fallback: "Could not load suggestions",
      }),
    refetchInterval: 30_000,
  });

export const createProactiveSetting = (input: {
  agentId: string;
  channelId: string;
  focus: string;
  intervalMinutes: number;
}) =>
  client("/api/proactive/settings", {
    method: "POST",
    body: input,
    fallback: "Could not turn on background research",
  });
export const updateProactiveSetting = (
  id: string,
  input: { enabled?: boolean; intervalMinutes?: number; focus?: string },
) =>
  client(`/api/proactive/settings/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: input,
    fallback: "Could not change background research",
  });
export const runProactiveNow = (id: string) =>
  client(`/api/proactive/settings/${encodeURIComponent(id)}/run`, {
    method: "POST",
    fallback: "Could not start background research",
  });
export const removeProactiveSetting = (id: string) =>
  client(`/api/proactive/settings/${encodeURIComponent(id)}`, {
    method: "DELETE",
    fallback: "Could not remove background research",
  });
export const resolveSuggestion = (id: string, action: "start" | "dismiss") =>
  client(`/api/proactive/suggestions/${encodeURIComponent(id)}/${action}`, {
    method: "POST",
    fallback:
      action === "start"
        ? "Could not start this suggestion"
        : "Could not dismiss this suggestion",
  });

/** A setting's research produces suggestions, so a change to either refreshes both. */
const settleProactive = (queryClient: QueryClient) => () =>
  Promise.all([
    queryClient.invalidateQueries({ queryKey: proactiveKeys.settings }),
    queryClient.invalidateQueries({ queryKey: proactiveKeys.suggestions }),
  ]);

/** Start a suggested next step as a task, or dismiss it. */
export const resolveSuggestionMutationOptions = (queryClient: QueryClient) =>
  mutationOptions({
    mutationFn: ({ id, action }: { id: string; action: "start" | "dismiss" }) =>
      resolveSuggestion(id, action),
    onSuccess: settleProactive(queryClient),
  });

export const createProactiveSettingMutationOptions = (
  queryClient: QueryClient,
) =>
  mutationOptions({
    mutationFn: createProactiveSetting,
    onSuccess: settleProactive(queryClient),
  });

/** What can be done to one background-research setting from its row. */
export type ProactiveChange =
  | { kind: "toggle" }
  | { kind: "run" }
  | { kind: "remove" }
  | { kind: "interval"; minutes: number };

export const changeProactiveSettingMutationOptions = (
  queryClient: QueryClient,
) =>
  mutationOptions({
    mutationFn: ({
      setting,
      change,
    }: {
      setting: Pick<ProactiveSetting, "id" | "enabled">;
      change: ProactiveChange;
    }) =>
      change.kind === "run"
        ? runProactiveNow(setting.id)
        : change.kind === "remove"
          ? removeProactiveSetting(setting.id)
          : updateProactiveSetting(
              setting.id,
              change.kind === "toggle"
                ? { enabled: !setting.enabled }
                : { intervalMinutes: change.minutes },
            ),
    onSuccess: settleProactive(queryClient),
  });
