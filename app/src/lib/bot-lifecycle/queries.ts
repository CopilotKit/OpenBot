import { queryOptions } from "@tanstack/react-query";
import { client } from "@/lib/client";

/** How loudly one Bot may reach the signed-in person. Badges on the web always show. */
export type BotNotify = "all" | "needs_input" | "none";
export type UpdateKind = "progress" | "decision" | "question";
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
};

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

export const botPath = (agentId: string) =>
  `/api/bots/${encodeURIComponent(agentId)}`;

export function botAttentionQueryOptions() {
  return queryOptions({
    queryKey: botLifecycleKeys.attention,
    queryFn: (): Promise<BotAttention[]> =>
      client("/api/bots/attention", "bots", {
        fallback: "Could not load what your Bots need",
      }),
    // Questions and approvals arrive from headless work nobody is watching, so this polls.
    refetchInterval: 15_000,
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
