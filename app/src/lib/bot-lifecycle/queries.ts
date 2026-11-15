import { queryOptions } from "@tanstack/react-query";
import {
  getBotActivity,
  getBotLifecycle,
  listBotAttention,
  resetBot,
} from "@/lib/api/generated/bots/bots";
import type {
  BotActivityItem,
  BotActivityItemKind,
  BotActivity as BotActivityModel,
  BotAttention as BotAttentionModel,
  BotLifecycle as BotLifecycleModel,
  BotNotify as BotNotifyModel,
  BotResetCounts,
} from "@/lib/api/generated/model";
import { getNotificationSettings } from "@/lib/api/generated/notification-settings/notification-settings";
import { idempotencyKey, ORGANIZATION_ID } from "@/lib/api/request";

/** How loudly one Bot may reach the signed-in person. Badges on the web always show. */
export type BotNotify = BotNotifyModel;
/** `attention` is a ping: what the person's Bots found in their check-ins that needs them. */
export type UpdateKind = "progress" | "decision" | "question" | "attention";
export type UpdateTransport = "slack" | "teams" | "sms" | "push";

/** The signed-in person's own state with one Bot, nobody else's: the API's `BotLifecycle`. */
export type BotLifecycle = BotLifecycleModel;

/** What waits on the signed-in person from one Bot: the API's `BotAttention`. */
export type BotAttention = BotAttentionModel;

/**
 * What waits on the person from every Bot, read to the end. `lastPingId` is the person's newest
 * ping, across all their Bots: one ping folds every Bot's items, so the app sends one browser
 * notification each time it changes, never one per item.
 */
type AttentionBody = { bots: BotAttention[]; lastPingId: string | null };

export type ActivityKind = BotActivityItemKind;
export type ActivityItem = BotActivityItem;
export type BotActivity = BotActivityModel;

/** What a reset would delete, per kind, before anything is. */
export type ResetPlan = BotResetCounts;

/** Where each kind of update may go. */
export type UpdateRouting = Record<UpdateKind, UpdateTransport[] | "all">;

export const botLifecycleKeys = {
  all: ["bot-lifecycle"] as const,
  attention: ["bot-lifecycle", "attention"] as const,
  routing: ["bot-lifecycle", "routing"] as const,
  lifecycle: (agentId: string) =>
    ["bot-lifecycle", "lifecycle", agentId] as const,
  activity: (agentId: string) =>
    ["bot-lifecycle", "activity", agentId] as const,
  resetPlan: (agentId: string) =>
    ["bot-lifecycle", "reset-plan", agentId] as const,
};

/**
 * Every page of what the person's Bots have waiting on them.
 *
 * The API pages it, and the badges want every Bot, so this reads to the end. Each page carries the
 * newest ping; the last page's is the newest read. A server that hands back the cursor it was given
 * would never end the list, so a repeated cursor ends it too.
 */
async function everyAttention(): Promise<AttentionBody> {
  const bots: BotAttention[] = [];
  let lastPingId: string | null = null;
  const seen = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await listBotAttention(
      ORGANIZATION_ID,
      "me",
      { limit: 100, ...(cursor ? { cursor } : {}) },
      { fallback: "Could not load what your Bots need" },
    );
    bots.push(...page.attention);
    lastPingId = page.lastPingId ?? lastPingId;
    if (cursor) seen.add(cursor);
    cursor = page.nextCursor ?? undefined;
  } while (cursor && !seen.has(cursor));
  return { bots, lastPingId };
}

/*
 * One read of the person's Bot attention answers two questions: what each Bot has waiting on the
 * person, and which ping told them last. Both factories share the key, so they are one request
 * polled once, and each component sees only the half it asked for.
 */
const attentionQuery = {
  queryKey: botLifecycleKeys.attention,
  queryFn: (): Promise<AttentionBody> => everyAttention(),
  // Questions, approvals and pings arrive from headless work nobody is watching, so this polls.
  refetchInterval: 15_000,
};

export function botAttentionQueryOptions() {
  return queryOptions({
    ...attentionQuery,
    select: (body): BotAttention[] => body.bots,
  });
}

/**
 * The same read, whole, for code outside a component that reads it once rather than watching it:
 * `ensureQueryData` hands back what the badge's poll already holds.
 */
export function botAttentionBodyQueryOptions() {
  return queryOptions(attentionQuery);
}

/** The person's newest ping, for the one browser notification each new ping sends. */
export function lastPingQueryOptions() {
  return queryOptions({
    ...attentionQuery,
    select: (body): string | null => body.lastPingId,
  });
}

export function botLifecycleQueryOptions(agentId: string) {
  return queryOptions({
    queryKey: botLifecycleKeys.lifecycle(agentId),
    queryFn: (): Promise<BotLifecycle> =>
      getBotLifecycle(ORGANIZATION_ID, agentId, {
        fallback: "Could not load this Bot's state",
      }),
  });
}

export function botActivityQueryOptions(agentId: string) {
  return queryOptions({
    queryKey: botLifecycleKeys.activity(agentId),
    queryFn: (): Promise<BotActivity> =>
      getBotActivity(ORGANIZATION_ID, agentId, {
        fallback: "Could not load this Bot's activity",
      }),
    refetchInterval: 10_000,
  });
}

/**
 * What a reset would delete: the reset itself, asked only to count (`validateOnly` true), which
 * deletes nothing. Each count is a new request, so each carries a fresh key.
 */
export function botResetPlanQueryOptions(agentId: string) {
  return queryOptions({
    queryKey: botLifecycleKeys.resetPlan(agentId),
    queryFn: async (): Promise<ResetPlan> =>
      (
        await resetBot(
          ORGANIZATION_ID,
          agentId,
          { validateOnly: true },
          { "Idempotency-Key": idempotencyKey() },
          { fallback: "Could not count what a reset would delete" },
        )
      ).deleted,
    // A notice about what will be deleted must be current, not cached.
    staleTime: 0,
  });
}

/** Where each kind of update may go: the person's own notification settings, through the API. */
export function updateRoutingQueryOptions() {
  return queryOptions({
    queryKey: botLifecycleKeys.routing,
    queryFn: async ({ signal }): Promise<UpdateRouting> =>
      (
        await getNotificationSettings(ORGANIZATION_ID, "me", {
          signal,
          fallback: "Could not load where your updates go",
        })
      ).routing,
  });
}
