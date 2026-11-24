import { queryOptions } from "@tanstack/react-query";
import {
  getBot,
  getBotHandoff,
  listBots,
  testBotConnection,
} from "@/lib/api/generated/bots/bots";
import type {
  Bot,
  BotHandoff,
  BotVisibility,
  ListBotsScope,
} from "@/lib/api/generated/model";
import { idempotencyKey, organizationId } from "@/lib/api/request";
import { ClientError } from "@/lib/client";
import { type Failure, failureOf } from "@/lib/load-failure";

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
  /** Every list of Bots, to refetch them together. A prefix of each `list`. */
  lists: () => ["agents", "list"] as const,
  /** A person's own list keeps the key it always had; Admin's list of every Bot has its own. */
  list: (hidden = false, scope: ListBotsScope = "caller") =>
    scope === "caller"
      ? (["agents", "list", { hidden }] as const)
      : (["agents", "list", { hidden, scope }] as const),
  detail: (agentId: string) => ["agents", "detail", agentId] as const,
  botRouteDetail: (agentId: string) =>
    ["agents", "bot-route-detail", agentId] as const,
  handoff: (agentId: string) => ["agents", "handoff", agentId] as const,
};

/**
 * Which Bots one Bot may hand work to, and whether this OpenBot lets it: the `BotHandoff` of
 * api/openapi.yaml.
 *
 * `enabled` is separate from the grants because the two fail differently: with it false, a grant
 * is a row nothing will ever read, so the screen says so instead of offering a switch wired to
 * nothing.
 * `grantable` false means every grant would be refused, and the screen says that once instead of
 * letting each switch bounce with the same message.
 */
export type HandoffGrants = BotHandoff;

/**
 * Every Bot in the list, page by page.
 *
 * The API pages every list (`cursor`, `limit`, `nextCursor`), and every screen here wants the whole
 * roster, so this reads to the end. A server that hands back the cursor it was given is a server
 * that would never end the list, so a repeated cursor ends it too.
 */
async function everyBot(
  hidden: boolean,
  scope: ListBotsScope,
): Promise<AgentProfile[]> {
  const bots: AgentProfile[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await listBots(
      organizationId(),
      {
        ...(hidden ? { hidden } : {}),
        ...(scope === "caller" ? {} : { scope }),
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

/**
 * The Bots a screen lists. `scope` is `caller` everywhere a person sees, picks or talks to a Bot,
 * and `organization` on Admin's screens only (`useBotListScope`, lib/agents/list-scope.tsx).
 */
export function agentListQueryOptions(
  hidden = false,
  scope: ListBotsScope = "caller",
) {
  return queryOptions({
    queryKey: agentKeys.list(hidden, scope),
    queryFn: (): Promise<AgentProfile[]> => everyBot(hidden, scope),
  });
}

export function agentQueryOptions(agentId: string) {
  return queryOptions({
    queryKey: agentKeys.detail(agentId),
    queryFn: async (): Promise<AgentProfile> =>
      (
        await getBot(organizationId(), agentId, {
          fallback: "Couldn't load this Bot.",
        })
      ).bot,
  });
}

/**
 * Whether a Bot is, right now, not one this person can use: the read of it answers "not found".
 *
 * A verdict about this moment, asked when a message to the Bot was refused, so it is not cached and
 * it fails closed: only the API's own 404 says the Bot is gone. A read that could not be made, or a
 * server that broke, says nothing about the Bot, and answers false.
 */
export async function botNoLongerUsable(agentId: string): Promise<boolean> {
  try {
    await getBot(organizationId(), agentId);
    return false;
  } catch (error) {
    return error instanceof ClientError && error.status === 404;
  }
}

export function agentHandoffQueryOptions(agentId: string) {
  return queryOptions({
    queryKey: agentKeys.handoff(agentId),
    queryFn: (): Promise<HandoffGrants> =>
      getBotHandoff(organizationId(), agentId, {
        fallback: "Could not load which Bots this one may ask",
      }),
  });
}

/**
 * What the server said when it tried the endpoint. A refusal is kept whole, so a hold (OpenBot
 * moving the organization) is drawn calmly rather than as an unreachable address (lib/load-failure.tsx).
 */
export type ConnectionVerdict =
  | { ok: true; events: string[] }
  | { ok: false; reason: Failure };

/** What a person reads when the test itself could not be run. */
const UNTESTED = "The connection could not be tested.";

/**
 * Ask the server to reach a Bot's address, from where a run will reach it.
 *
 * A plain function rather than a factory: the answer is about this moment, nothing caches it, and
 * there is no key for anything to invalidate. Fails closed, like the other verdicts here: an
 * address that cannot be tested is reported as unreachable, with the server's own sentence when it
 * gave one, rather than thrown at the form.
 *
 * The unsaved key is sent so the test matches the form as it stands, not as it was last saved.
 */
export async function testAgentConnection(
  endpoint: string,
  key: string,
): Promise<ConnectionVerdict> {
  try {
    const verdict = await testBotConnection(
      organizationId(),
      {
        endpoint,
        ...(key.trim() ? { headers: { Authorization: key.trim() } } : {}),
      },
      { "Idempotency-Key": idempotencyKey() },
      { fallback: UNTESTED },
    );
    if (verdict.ok) return { ok: true, events: verdict.events };
    return { ok: false, reason: { message: verdict.reason ?? UNTESTED } };
  } catch (error) {
    // A refusal carries the server's sentence (or UNTESTED); a request that never arrived does not.
    return {
      ok: false,
      reason: failureOf(error instanceof ClientError ? error : null, UNTESTED),
    };
  }
}
