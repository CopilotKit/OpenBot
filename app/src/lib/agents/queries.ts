import { queryOptions } from "@tanstack/react-query";
import { getBot, listBots } from "@/lib/api/generated/bots/bots";
import type { Bot, BotVisibility } from "@/lib/api/generated/model";
import { ORGANIZATION_ID } from "@/lib/api/request";
import { client, tryClient } from "@/lib/client";

export type AgentVisibility = BotVisibility;

/**
 * A coworker as the browser sees it: the `Bot` of api/openapi.yaml, generated from the spec.
 *
 * `canManage`, `mine`, `systemOwned` and the isolation fields are server-decided facts; components
 * render from the returned flags rather than recomputing ownership rules. What each field means is
 * written once, in the spec.
 */
export type AgentProfile = Bot;

/**
 * Whether this is an agent shared with you: made public by somebody else, not your own.
 *
 * Written once so every list of "shared with you" — the home screen's carousel among them — filters
 * through this rule rather than a copy of it.
 */
export function isSharedWithYou(agent: AgentProfile): boolean {
  return !agent.mine && agent.visibility === "public";
}

export const agentKeys = {
  all: ["agents"] as const,
  list: (hidden = false) => ["agents", "list", { hidden }] as const,
  detail: (agentId: string) => ["agents", "detail", agentId] as const,
  botRouteDetail: (agentId: string) =>
    ["agents", "bot-route-detail", agentId] as const,
  handoff: (agentId: string) => ["agents", "handoff", agentId] as const,
  capabilities: () => ["agents", "capabilities"] as const,
};

/** What kinds of coworker this deployment can create. */
export type AgentCapabilities = {
  /** Whether a coworker can run on the deployment's own Bot, with no endpoint of its own. */
  builtInAvailable: boolean;
  /**
   * Whether this deployment can give a Bot a computer of its own at all.
   *
   * Only where its computers are made one at a time (the supervisor, or a cluster's sandboxes).
   * Whether the signed-in person may is a different question, answered by the "Isolated Bots"
   * switch in `myCapabilitiesQueryOptions`.
   */
  isolationAvailable: boolean;
};

export function agentCapabilitiesQueryOptions() {
  return queryOptions({
    queryKey: agentKeys.capabilities(),
    queryFn: (): Promise<AgentCapabilities> =>
      client("/api/agents/capabilities", "capabilities", {
        fallback: "Couldn't load what OpenBot supports.",
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

/**
 * Every Bot in the list, page by page.
 *
 * The API pages every list (`cursor`, `limit`, `nextCursor`), and every screen here wants the whole
 * roster, so this reads to the end. A server that hands back the cursor it was given is a server
 * that would never end the list, so a repeated cursor ends it too.
 */
async function everyBot(hidden: boolean): Promise<AgentProfile[]> {
  const bots: AgentProfile[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await listBots(
      ORGANIZATION_ID,
      {
        ...(hidden ? { hidden } : {}),
        limit: 100,
        ...(cursor ? { cursor } : {}),
      },
      { fallback: "Couldn't load your Bots." },
    );
    bots.push(...page.bots);
    if (cursor) seen.add(cursor);
    cursor = page.nextCursor ?? undefined;
  } while (cursor && !seen.has(cursor));
  return bots;
}

export function agentListQueryOptions(hidden = false) {
  return queryOptions({
    queryKey: agentKeys.list(hidden),
    queryFn: (): Promise<AgentProfile[]> => everyBot(hidden),
  });
}

/**
 * The address of one Bot's routes the API spec does not cover yet (handoff, duplicate, hide, pin,
 * callback token). Package-defined IDs remain one path segment without changing their stored or
 * cache identity.
 */
export function agentApiPath(agentId: string): string {
  return `/api/agents/${encodeURIComponent(agentId)}`;
}

export function agentQueryOptions(agentId: string) {
  return queryOptions({
    queryKey: agentKeys.detail(agentId),
    queryFn: async (): Promise<AgentProfile> =>
      (
        await getBot(ORGANIZATION_ID, agentId, {
          fallback: "Couldn't load this Bot.",
        })
      ).bot,
  });
}

export function agentHandoffQueryOptions(agentId: string) {
  return queryOptions({
    queryKey: agentKeys.handoff(agentId),
    queryFn: (): Promise<HandoffGrants> =>
      client(`${agentApiPath(agentId)}/handoff`, "handoff", {
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
