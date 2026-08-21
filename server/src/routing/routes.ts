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
    if (roster.length === 0) {
      return context.json({ error: "No coworker is available." }, 409);
    }
    // The same default the composer shows: the first public coworker, else the first at all.
    const preferred =
      roster.find((a) => a.visibility === "public") ?? roster[0]!;
    const candidates: RoutingCandidate[] = roster.map((a) => ({
      id: a.id,
      name: a.name,
      roleDescription: a.roleDescription,
    }));

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
