import { queryOptions } from "@tanstack/react-query";
import { client, tryClient } from "@/lib/client";

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
    queryFn: (): Promise<AgentProfile[]> =>
      client(`/api/agents${hidden ? "?hidden=true" : ""}`, "agents", {
        fallback: "Could not load coworkers",
      }),
  });
}

export function agentQueryOptions(agentId: string) {
  return queryOptions({
    queryKey: agentKeys.detail(agentId),
    queryFn: (): Promise<AgentProfile> =>
      client(`/api/agents/${agentId}`, "agent", {
        fallback: "Could not load this coworker",
      }),
  });
}

/** What the server said when it tried the endpoint. */
export type ConnectionVerdict =
  | { ok: true; events: string[] }
  | { ok: false; reason: string };

/**
 * Ask the server to reach a coworker's endpoint, from where a run will reach it.
 *
 * A plain function rather than a factory: the answer is about this moment, nothing caches it, and
 * there is no key for anything to invalidate. Fails closed, like the other verdicts here — an
 * endpoint that cannot be tested is reported as unreachable rather than thrown at the form.
 *
 * The unsaved key is sent so the test matches the form as it stands, not as it was last saved.
 */
export async function testAgentConnection(
  endpoint: string,
  key: string,
): Promise<ConnectionVerdict> {
  try {
    const response = await tryClient("/api/agents/test-connection", {
      method: "POST",
      body: {
        endpoint,
        ...(key.trim() ? { headers: { Authorization: key.trim() } } : {}),
      },
    });
    const body = (await response.json().catch(() => null)) as
      | ConnectionVerdict
      | { error?: string }
      | null;
    if (body && "ok" in body) return body;
    return {
      ok: false,
      reason:
        (body as { error?: string } | null)?.error ??
        "The connection could not be tested.",
    };
  } catch {
    return { ok: false, reason: "The connection could not be tested." };
  }
}
