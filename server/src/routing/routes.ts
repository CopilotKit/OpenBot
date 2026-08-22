import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import type { AuditStore } from "../audit";
import { recordAuditEvent } from "../audit";
import type { AppVariables } from "../auth/guards";
import type { AgentProfileStore } from "../agents/profile-store";
import type { IntentRouter, RoutingCandidate } from "./classify";

const DEV_ACTOR_EMAIL = "dev@openbot.local";

/**
 * Decide which coworker an untagged message is for, before a channel is pinned to one.
 *
 * The roster is read for the person asking, so the router can only ever pick a coworker they are
 * already allowed to reach. The decision is recorded like every other one in the product: a
 * `channel.routed` row names where it went and why, and carries the candidate ids but never the
 * message itself, which the audit payload redaction would drop anyway.
 */
export function createRoutingRoutes(
  store: AgentProfileStore,
  router: IntentRouter,
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
  auditStore?: AuditStore,
  /**
   * Which systems a coworker can reach, for the router to weigh alongside what it is for.
   *
   * Optional, and absent leaves routing exactly as it was: a deployment with no connectors has
   * nothing to add here, and one that cannot answer the question should not have routing fail over
   * it. Asked per request rather than held, because a grant added a minute ago has to count.
   */
  reachableSystems?: (agentId: string) => Promise<readonly string[]>,
) {
  const routes = new Hono<{ Variables: AppVariables }>();

  routes.post("/", requireUser, async (context) => {
    const body = (await context.req.json().catch(() => null)) as {
      text?: unknown;
    } | null;
    const text = typeof body?.text === "string" ? body.text.trim() : "";
    if (!text) return context.json({ error: "A message is required." }, 400);

    const actor = context.var.actor;
    const roster = await store.list(actor, false);
    // The same default the composer shows: the first public coworker, else the first at all.
    const preferred =
      roster.find((a) => a.visibility === "public") ?? roster[0];
    if (!preferred) {
      return context.json({ error: "No coworker is available." }, 409);
    }
    const candidates: RoutingCandidate[] = await Promise.all(
      roster.map(async (a) => ({
        id: a.id,
        name: a.name,
        roleDescription: a.roleDescription,
        /*
         * Never allowed to break routing. A connector store that is slow or unhappy must not turn
         * "who is this for" into an error, so a failure here is the same as holding nothing: the
         * router falls back to matching on purpose alone, which is what it did before.
         */
        ...(reachableSystems
          ? {
              reaches: await reachableSystems(a.id).catch(
                () => [] as readonly string[],
              ),
            }
          : {}),
      })),
    );

    const decision = await router.route(text, candidates, preferred.id);

    if (auditStore) {
      await recordAuditEvent(auditStore, {
        eventType: "channel.routed",
        targetType: "agent",
        targetId: decision.agentId,
        ...(actor?.id && actor.email !== DEV_ACTOR_EMAIL
          ? { actorUserId: actor.id }
          : {}),
        payload: {
          chosen: decision.agentId,
          reason: decision.reason,
          fallback: decision.fallback,
          viaMention: false,
          candidates: candidates.map((c) => c.id),
        },
      });
    }

    return context.json({
      agentId: decision.agentId,
      name: decision.name,
      reason: decision.reason,
      fallback: decision.fallback,
    });
  });

  return routes;
}
