import { queryOptions } from "@tanstack/react-query";
import { client } from "@/lib/client";

/** One Bot's computer, as Admin sees it. */
export type ComputerProfile = {
  botId: string;
  running: boolean;
  startedAt: string | null;
  egress: string | null;
};

/** Whether each Bot has a browser profile of its own, or they share one. */
export type ComputerIsolation = "per-bot" | "shared";

/** What the list endpoint answers: the computers, and how they are separated. */
export type ComputerFleet = {
  computers: ComputerProfile[];
  isolation?: ComputerIsolation;
};

/**
 * Whether the boundary acts on its verdict.
 *
 * `dry-run` records what it would have refused without refusing it, which is how a policy is tried
 * out before it stops a Bot mid-task.
 */
export type PolicyMode = "dry-run" | "enforce";

/** The rules a Bot's actions are judged against. */
export type ActionPolicy = {
  mode: PolicyMode;
  deny: string[];
  allow: string[];
};

export const computerKeys = {
  all: ["computers"] as const,
  fleet: () => ["computers", "fleet"] as const,
  policy: () => ["computers", "policy"] as const,
};

/**
 * A placeholder id in the path. The endpoint answers with every computer regardless, so this is
 * addressing a collection through a member's route rather than naming one.
 */
const FLEET_ID = "openbot-computer";

/** No envelope key: the body carries both the list and the isolation mode. */
export function computerFleetQueryOptions() {
  return queryOptions({
    queryKey: computerKeys.fleet(),
    queryFn: async (): Promise<ComputerFleet> => {
      const response = await client(`/api/computers/${FLEET_ID}/computers`, {
        fallback: "The computers could not be listed.",
      });
      return response.json();
    },
  });
}

export function actionPolicyQueryOptions() {
  return queryOptions({
    queryKey: computerKeys.policy(),
    queryFn: (): Promise<ActionPolicy> =>
      client("/api/computers/policy", "policy", {
        fallback: "The boundary could not be read.",
      }),
  });
}
