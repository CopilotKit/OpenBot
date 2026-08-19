import { queryOptions } from "@tanstack/react-query";

export type AgentVisibility = "public" | "private";

/**
 * A coworker as the browser sees it.
 *
 * `canManage` and `systemOwned` are server-decided authorization facts; components render from the
 * returned flags rather than recomputing ownership rules.
 */
export type AgentProfile = {
  id: string;
  name: string;
  title: string;
  roleDescription: string;
  avatarSeed: string;
  visibility: AgentVisibility;
  /** Where this coworker runs. Null for the Bot in the box. */
  endpoint: string | null;
  /** Whether a key is set for it. Never the key itself. */
  hasAuth: boolean;
  hidden: boolean;
  /**
   * Whether this person has silenced this Bot's notifications.
   *
   * Per person, like `hidden`. Silencing changes nothing about what the Bot does or what the audit
   * trail records; it only stops this person being interrupted by it.
   */
  notificationsMuted: boolean;
  systemOwned: boolean;
  canManage: boolean;
  /**
   * Whether the signed-in person created this coworker.
   *
   * Separate from `canManage`, which is also true for administrators on everybody's coworkers. Split
   * a roster on `canManage` and an administrator's "mine" fills up with other people's work.
   */
  mine: boolean;
};

export const agentKeys = {
  all: ["agents"] as const,
  list: (hidden = false) => ["agents", "list", { hidden }] as const,
  detail: (agentId: string) => ["agents", "detail", agentId] as const,
};

export function agentListQueryOptions(hidden = false) {
  return queryOptions({
    queryKey: agentKeys.list(hidden),
    queryFn: async (): Promise<AgentProfile[]> => {
      const response = await fetch(
        `/api/agents${hidden ? "?hidden=true" : ""}`,
        {
          credentials: "include",
        },
      );
      if (!response.ok) throw new Error("Could not load coworkers");
      return ((await response.json()) as { agents: AgentProfile[] }).agents;
    },
  });
}

export function agentQueryOptions(agentId: string) {
  return queryOptions({
    queryKey: agentKeys.detail(agentId),
    queryFn: async (): Promise<AgentProfile> => {
      const response = await fetch(`/api/agents/${agentId}`, {
        credentials: "include",
      });
      if (!response.ok) throw new Error("Could not load this coworker");
      return ((await response.json()) as { agent: AgentProfile }).agent;
    },
  });
}
