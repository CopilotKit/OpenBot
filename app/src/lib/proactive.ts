import {
  mutationOptions,
  type QueryClient,
  queryOptions,
} from "@tanstack/react-query";
import { botLifecycleKeys } from "@/lib/bot-lifecycle/queries";
import { client } from "@/lib/client";
import { taskKeys } from "@/lib/tasks/queries";

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

/**
 * `GET /api/proactive/settings`. `allowed` is false when an admin turned check-ins off for this
 * person, so their own switches can say who turned them off.
 */
type ProactiveSettingsBody = {
  settings: ProactiveSetting[];
  allowed: boolean;
};

/**
 * Something a Bot's check-in found that needs the person: what it is, why (`detail`), and where it
 * read that. Open items only; Start and Hide take it off the list.
 *
 * A new item always names its source. Items from before check-ins may not, so `sourceApp` and
 * `sourceRef` stay nullable. `pingId` is the ping that told the person about it, null while it waits
 * for their hourly slot; the list shows it either way.
 */
export type ProactiveSuggestion = {
  id: string;
  agentId: string;
  title: string;
  detail: string;
  sourceApp: string | null;
  sourceRef: string | null;
  sourceLink: string | null;
  pingId: string | null;
  createdAt: string;
};

export const proactiveKeys = {
  settings: ["proactive", "settings"] as const,
  suggestions: ["proactive", "suggestions"] as const,
};

/*
 * One read of `/api/proactive/settings` answers two questions: which Bots check in, and whether an
 * admin allows it at all. Both factories share the key, so they are one request, and each component
 * sees only the half it asked for.
 */
const proactiveSettingsQuery = {
  queryKey: proactiveKeys.settings,
  queryFn: async (): Promise<ProactiveSettingsBody> =>
    (
      await client("/api/proactive/settings", {
        fallback: "Couldn't load your check-ins",
      })
    ).json(),
  refetchInterval: 30_000,
};

export const proactiveSettingsQueryOptions = () =>
  queryOptions({
    ...proactiveSettingsQuery,
    select: (body): ProactiveSetting[] => body.settings,
  });

/** Whether an admin lets this person's Bots check in. */
export const proactiveAllowedQueryOptions = () =>
  queryOptions({
    ...proactiveSettingsQuery,
    select: (body): boolean => body.allowed,
  });

export const proactiveSuggestionsQueryOptions = () =>
  queryOptions({
    queryKey: proactiveKeys.suggestions,
    queryFn: (): Promise<ProactiveSuggestion[]> =>
      client("/api/proactive/suggestions", "suggestions", {
        fallback: "Couldn't load what your Bots found",
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
    fallback: "Couldn't turn on check-ins",
  });
export const updateProactiveSetting = (
  id: string,
  input: { enabled?: boolean; intervalMinutes?: number; focus?: string },
) =>
  client(`/api/proactive/settings/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: input,
    fallback: "Couldn't change check-ins",
  });
export const runProactiveNow = (id: string) =>
  client(`/api/proactive/settings/${encodeURIComponent(id)}/run`, {
    method: "POST",
    fallback: "Couldn't start a check-in",
  });
export const removeProactiveSetting = (id: string) =>
  client(`/api/proactive/settings/${encodeURIComponent(id)}`, {
    method: "DELETE",
    fallback: "Couldn't remove check-ins",
  });

/**
 * Start an item as a task in a conversation of its own, or Hide it. The server answers a second
 * Start with the task the first one opened, so a double tap starts one task. The task arrives on the
 * lists through the tasks query, so nothing here reads the answer.
 */
export const resolveSuggestion = (id: string, action: "start" | "dismiss") =>
  client(`/api/proactive/suggestions/${encodeURIComponent(id)}/${action}`, {
    method: "POST",
    fallback:
      action === "start"
        ? "Couldn't start this. Try again."
        : "Couldn't hide this. Try again.",
  });

/** A setting's check-ins produce items, so a change to either refreshes both. */
const settleProactive = (queryClient: QueryClient) => () =>
  Promise.all([
    queryClient.invalidateQueries({ queryKey: proactiveKeys.settings }),
    queryClient.invalidateQueries({ queryKey: proactiveKeys.suggestions }),
  ]);

/**
 * Start an item as a task, or Hide it. Either takes it off every list at once: the Bots page, the
 * Bot's page and the skins all read the one suggestions query. Start also opens a task, and both move
 * the counts on the sidebar's badge, so the tasks and the attention counts are read again too.
 */
export const resolveSuggestionMutationOptions = (queryClient: QueryClient) =>
  mutationOptions({
    mutationFn: ({ id, action }: { id: string; action: "start" | "dismiss" }) =>
      resolveSuggestion(id, action),
    onSuccess: () =>
      Promise.all([
        settleProactive(queryClient)(),
        queryClient.invalidateQueries({ queryKey: taskKeys.all }),
        queryClient.invalidateQueries({
          queryKey: botLifecycleKeys.attention,
        }),
      ]),
  });

export const createProactiveSettingMutationOptions = (
  queryClient: QueryClient,
) =>
  mutationOptions({
    mutationFn: createProactiveSetting,
    onSuccess: settleProactive(queryClient),
  });

/** What can be done to one Bot's check-ins from its row. */
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
