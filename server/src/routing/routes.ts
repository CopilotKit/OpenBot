import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import type { AuditStore } from "../audit";
import { recordAuditEvent } from "../audit";
import type { AppVariables } from "../auth/guards";
import type { AgentProfileStore } from "../agents/profile-store";
import type { IntentRouter, RoutingCandidate } from "./classify";

const DEV_ACTOR_EMAIL = "dev@openbot.local";

/**
 * Decide which coworker a message is for, before a channel is pinned to one.
 *
 * Two ways a message gets a coworker, and the trail records both so it can tell them apart. When the
 * person named one with `@`, the body carries that `agentId`: no model runs, the choice is honoured
 * as-is, and the row is written with `viaMention: true` naming the person as the reason. When they
 * named no one, the router reads the message against what each coworker is for and picks, and the
 * row is written with `viaMention: false` and the model's reason.
 *
 * The roster is read for the person asking, so neither path can land on a coworker they are not
 * already allowed to reach. The row names where it went and why and carries the candidate ids, but
 * never the message itself, which the audit payload redaction would drop anyway.
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
      agentId?: unknown;
    } | null;
    const text = typeof body?.text === "string" ? body.text.trim() : "";
    if (!text) return context.json({ error: "A message is required." }, 400);
    const mentionedId =
      typeof body?.agentId === "string" && body.agentId.trim()
        ? body.agentId.trim()
        : undefined;

    const actor = context.var.actor;
    const roster = await store.list(actor, false);
    // The same default the composer shows: the first public coworker, else the first at all.
    const preferred =
      roster.find((a) => a.visibility === "public") ?? roster[0];
    if (!preferred) {
      return context.json({ error: "No coworker is available." }, 409);
    }
    const candidates: RoutingCandidate[] = roster.map((a) => ({
      id: a.id,
      name: a.name,
      roleDescription: a.roleDescription,
    }));

    const record = (payload: Record<string, unknown>) => {
      if (!auditStore) return;
      return recordAuditEvent(auditStore, {
        eventType: "channel.routed",
        targetType: "agent",
        targetId: String(payload.chosen),
        ...(actor?.id && actor.email !== DEV_ACTOR_EMAIL
          ? { actorUserId: actor.id }
          : {}),
        payload: { ...payload, candidates: candidates.map((c) => c.id) },
      });
    };

    // An `@` names a coworker: nothing to decide, but the choice still gets a row so the trail is
    // not silent about mentioned conversations. Only honoured when the named coworker is one the
    // person can reach — the same guarantee the router path carries.
    const mentioned = mentionedId
      ? candidates.find((c) => c.id === mentionedId)
      : undefined;
    if (mentioned) {
      const who = actor?.name?.trim() || actor?.email || "a person";
      const reason = `named with @ by ${who}`;
      await record({
        chosen: mentioned.id,
        reason,
        fallback: false,
        viaMention: true,
      });
      return context.json({
        agentId: mentioned.id,
        name: mentioned.name,
        reason,
        fallback: false,
      });
    }

    const decision = await router.route(text, candidates, preferred.id);

    await record({
      chosen: decision.agentId,
      reason: decision.reason,
      fallback: decision.fallback,
      viaMention: false,
    });

    return context.json({
      agentId: decision.agentId,
      name: decision.name,
      reason: decision.reason,
      fallback: decision.fallback,
    });
  });

  return routes;
}
