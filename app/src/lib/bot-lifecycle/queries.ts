import { queryOptions } from "@tanstack/react-query";
import { client } from "@/lib/client";

/** How loudly one Bot may reach the signed-in person. Badges on the web always show. */
export type BotNotify = "all" | "needs_input" | "none";
/** `attention` is a ping: what the person's Bots found in their check-ins that needs them. */
export type UpdateKind = "progress" | "decision" | "question" | "attention";
export type UpdateTransport = "slack" | "teams" | "sms" | "push";

/** The signed-in person's relationship with one Bot. Never anybody else's. */
export type BotLifecycle = {
  agentId: string;
  paused: boolean;
  pausedAt: string | null;
  notify: BotNotify;
};

/** What waits on the signed-in person from one Bot, as the sidebar draws it. */
export type BotAttention = {
  agentId: string;
  name: string;
  questions: number;
  approvals: number;
  handoffs: number;
  unread: number;
  paused: boolean;
  notify: BotNotify;
  /** Open items from this Bot's check-ins. */
  items: number;
  /** Its tasks that wait on the person: an approval or a question, a reply to read, or a failure. */
  tasks: { needsInput: number; ready: number; failed: number };
};

/**
 * `GET /api/bots/attention`. `lastPingId` is the person's newest ping, across all their Bots: one
 * ping folds every Bot's items, so the app sends one browser notification each time it changes,
 * never one per item.
 */
type AttentionBody = { bots: BotAttention[]; lastPingId: string | null };

export type ActivityKind =
  | "routine"
  | "responsibility"
  | "handoff"
  | "approval"
  | "question"
  | "follow_up";

export type ActivityItem = {
  id: string;
  kind: ActivityKind;
  title: string;
  detail: string | null;
  status: string;
  at: string;
  channelId: string | null;
  needsYou: boolean;
  /** A delegated task the server says can still be stopped. */
  stoppable: boolean;
  /** A follow-up the server says can still be cancelled. */
  cancellable: boolean;
};

export type BotActivity = {
  inProgress: ActivityItem[];
  scheduled: ActivityItem[];
  completed: ActivityItem[];
};

/** What a reset would delete, per kind, before anything is. */
export type ResetPlan = {
  conversations: number;
  sharedConversationsKept: number;
  memorySources: number;
  memories: number;
  routines: number;
  responsibilities: number;
  followUps: number;
  formedMemories: number;
  backgroundResearch: number;
  standingApprovals: number;
};

/**
 * Where each kind of update may go. `attention` is answered once the server delivers pings; until
 * then the kind is absent, and the routing screen leaves its row out.
 */
export type UpdateRouting = Record<
  Exclude<UpdateKind, "attention">,
  UpdateTransport[] | "all"
> & { attention?: UpdateTransport[] | "all" };

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

export const botPath = (agentId: string) =>
  `/api/bots/${encodeURIComponent(agentId)}`;

/*
 * One read of `/api/bots/attention` answers two questions: what each Bot has waiting on the person,
 * and which ping told them last. Both factories share the key, so they are one request polled once,
 * and each component sees only the half it asked for.
 */
const attentionQuery = {
  queryKey: botLifecycleKeys.attention,
  queryFn: async (): Promise<AttentionBody> =>
    (
      await client("/api/bots/attention", {
        fallback: "Could not load what your Bots need",
      })
    ).json(),
  // Questions, approvals and pings arrive from headless work nobody is watching, so this polls.
  refetchInterval: 15_000,
};

export function botAttentionQueryOptions() {
  return queryOptions({
    ...attentionQuery,
    select: (body): BotAttention[] => body.bots,
  });
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
      client(`${botPath(agentId)}/lifecycle`, "lifecycle", {
        fallback: "Could not load this Bot's state",
      }),
  });
}

export function botActivityQueryOptions(agentId: string) {
  return queryOptions({
    queryKey: botLifecycleKeys.activity(agentId),
    queryFn: (): Promise<BotActivity> =>
      client(`${botPath(agentId)}/activity`, "activity", {
        fallback: "Could not load this Bot's activity",
      }),
    refetchInterval: 10_000,
  });
}

export function botResetPlanQueryOptions(agentId: string) {
  return queryOptions({
    queryKey: botLifecycleKeys.resetPlan(agentId),
    queryFn: (): Promise<ResetPlan> =>
      client(`${botPath(agentId)}/reset`, "plan", {
        fallback: "Could not count what a reset would delete",
      }),
    // A notice about what will be deleted must be current, not cached.
    staleTime: 0,
  });
}

export function updateRoutingQueryOptions() {
  return queryOptions({
    queryKey: botLifecycleKeys.routing,
    queryFn: (): Promise<UpdateRouting> =>
      client("/api/bots/routing", "routing", {
        fallback: "Could not load where your updates go",
      }),
  });
}
