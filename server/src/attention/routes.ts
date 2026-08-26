/**
 * The attention inbox over HTTP.
 *
 * Deliberately not `/api/admin/...`: the audit page is the administrator's view of everything, and
 * is gated accordingly. The inbox is the working person's view of their own Bots' trouble, so it is
 * scoped per item by the same `canUseBot` the rest of the surface uses, and an administrator sees
 * all of it the way they see all Bots.
 */

import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import type { BotAccessCheck } from "../agents/profile-policy";
import type { AuditReader } from "../audit";
import type { AppVariables } from "../auth/guards";
import type { AttentionStore } from "./store";
import { ATTENTION_EVENT_TYPES, attentionItemsFrom, botOf } from "./view";

/**
 * How much trail the view reads. Bounded and biased to recency for the same reason the policy
 * dry-run is: the inbox answers "what needs me now", and an unresolved refusal from beyond this
 * window is answered by the Audit page, which exists for looking back.
 */
const SCAN_LIMIT = 200;

export function createAttentionRoutes(
  auditReader: AuditReader,
  store: AttentionStore,
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
  canUseBot: BotAccessCheck,
) {
  const routes = new Hono<{ Variables: AppVariables }>();

  routes.get("/", requireUser, async (context) => {
    const { events } = await auditReader.list({
      limit: SCAN_LIMIT,
      eventType: ATTENTION_EVENT_TYPES.join(","),
    });
    const resolved = await store.resolvedAmong(events.map((one) => one.id));
    const items = attentionItemsFrom(events, resolved);

    if (context.var.actor.role === "admin") {
      return context.json({ items });
    }
    /*
     * Scoped per item rather than per request: one inbox can name several Bots, and which of them
     * this person may see is the store's question, asked with the same check the roster and the
     * computer use. Sequential on purpose — the distinct Bots in a 200-row window are few, and the
     * memo keeps it to one ask per Bot.
     */
    const allowed = new Map<string, boolean>();
    const visible = [];
    for (const item of items) {
      let may = allowed.get(item.botId);
      if (may === undefined) {
        may = await canUseBot(context.var.actor, item.botId);
        allowed.set(item.botId, may);
      }
      if (may) visible.push(item);
    }
    return context.json({ items: visible });
  });

  routes.post("/:eventId/resolve", requireUser, async (context) => {
    const eventId = context.req.param("eventId");
    const event = await store.event(eventId);
    /*
     * Only a real attention row can be resolved. Anything else — a made-up id, a trail row of some
     * other kind — answers the same way, so this cannot be used to probe what the trail holds.
     */
    const kinds: readonly string[] = ATTENTION_EVENT_TYPES;
    if (!event || !kinds.includes(event.eventType)) {
      return context.json({ error: "There is no such attention item." }, 404);
    }
    // The same reading the view uses: a tool rejection's target is the tool, not the Bot.
    const botId = botOf(event);
    if (
      context.var.actor.role !== "admin" &&
      !(botId && (await canUseBot(context.var.actor, botId)))
    ) {
      return context.json({ error: "There is no such attention item." }, 404);
    }

    const resolution = await store.resolve(eventId, context.var.actor.id);
    return context.json({ resolution });
  });

  return routes;
}
