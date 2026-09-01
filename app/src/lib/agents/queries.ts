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
  avatarUrl: string | null;
  visibility: AgentVisibility;
  /** Where this coworker runs. Null for the Bot in the box. */
  endpoint: string | null;
  /**
   * Whether it runs on this deployment's own Bot.
   *
   * Creating a coworker with no endpoint stores the deployment's managed address, so `endpoint`
   * alone cannot tell "built-in" from "hosted by a person" — and the difference decides whether the
   * Connection screen asks for a callback token. A built-in coworker calls tools back with the
   * deployment's own credential and needs no setup at all.
   */
  builtIn: boolean;
  /** Whether a key is set for it. Never the key itself. */
  hasAuth: boolean;
  /**
   * Whether this coworker holds a credential for calling tools back.
   *
   * A boolean, because the token is readable exactly once: in the response that issued it. The
   * surface needs this only to decide between offering "generate" and "rotate".
   */
  hasCallbackToken: boolean;
  hidden: boolean;
  systemOwned: boolean;
  canManage: boolean;
  /** Owners may customize their Bot; administrators may also brand package-owned Bots. */
  canCustomizeAvatar: boolean;
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
  handoff: (agentId: string) => ["agents", "handoff", agentId] as const,
  capabilities: () => ["agents", "capabilities"] as const,
};

/** What kinds of coworker this deployment can create. */
export type AgentCapabilities = {
  /** Whether a coworker can run on the deployment's own Bot, with no endpoint of its own. */
  builtInAvailable: boolean;
};

export function agentCapabilitiesQueryOptions() {
  return queryOptions({
    queryKey: agentKeys.capabilities(),
    queryFn: (): Promise<AgentCapabilities> =>
      client("/api/agents/capabilities", "capabilities", {
        fallback: "Could not load what this deployment supports",
      }),
    // Deployment configuration, not data: it cannot change without the server restarting.
    staleTime: Number.POSITIVE_INFINITY,
  });
}

/** Which Bots one Bot may hand work to, and whether this deployment lets it. */
export type HandoffGrants = {
  /**
   * Whether the capability is switched on at all.
   *
   * Separate from the grants because the two fail differently: with this false, a grant is a row
   * nothing will ever read, so the screen says so rather than offering a switch wired to nothing.
   */
  enabled: boolean;
  /** Whether the signed-in person may change any of it. Granting is an administrator's. */
  canGrant: boolean;
  /** Bot ids this Bot may address today. */
  reachable: string[];
  /**
   * Whether this Bot can hold such a grant at all.
   *
   * The handing-on tool executes inside this deployment's own run loop, so only a Bot that runs in
   * it can be offered one. False means every grant would be refused, and the screen should say that
   * once instead of letting each switch bounce with the same message.
   */
  grantable: boolean;
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

export function agentHandoffQueryOptions(agentId: string) {
  return queryOptions({
    queryKey: agentKeys.handoff(agentId),
    queryFn: (): Promise<HandoffGrants> =>
      client(`/api/agents/${agentId}/handoff`, "handoff", {
        fallback: "Could not load which Bots this one may ask",
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
