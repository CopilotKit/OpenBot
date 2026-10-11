import { Hono, type MiddlewareHandler } from "hono";
import { type AuditStore, recordAuditEvent } from "../audit";
import { type AppVariables, requireAdmin } from "../auth/guards";
import { covers, exposureOf } from "./shared-use";
import {
  SharedUseRequestDecidedError,
  type SharedUseStore,
} from "./shared-use-store";

/**
 * Where a Bot's use of a Shared app is asked for and answered.
 *
 * THE PROPOSAL IS ALWAYS THE SERVER'S. An owner asks; what they ask FOR is the Bot's exposure as
 * this deployment reads it, so a request cannot be worded wider than the Bot actually is, and an
 * administrator approving it approves exactly what will be checked on the next call.
 */
export function createSharedUseRoutes(
  store: SharedUseStore,
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
  audit: AuditStore,
) {
  const routes = new Hono<{ Variables: AppVariables }>();
  routes.use("*", requireUser);

  const ownerOrAdmin = async (actor: AppVariables["actor"], botId: string) =>
    actor.role === "admin" ||
    (await store.botFacts(botId)).ownerUserId === actor.id;

  routes.get("/", async (context) => {
    const forbidden = requireAdmin(context);
    if (forbidden) return forbidden;
    return context.json({ requests: await store.listRequests("pending") });
  });

  for (const decision of ["approve", "decline"] as const) {
    routes.post(`/:id/${decision}`, async (context) => {
      const forbidden = requireAdmin(context);
      if (forbidden) return forbidden;
      try {
        const request = await store.decide({
          id: context.req.param("id"),
          by: context.var.actor.id,
          decision,
        });
        await recordAuditEvent(audit, {
          eventType:
            decision === "approve"
              ? "shared_use.approved"
              : "shared_use.declined",
          targetType: "mcp_server",
          targetId: request.serverId,
          actorUserId: context.var.actor.id,
          payload: {
            bot: request.botId,
            server: request.serverId,
            request: request.id,
            audience: request.proposed.audience,
            outsideInput: request.proposed.outsideInput,
          },
        });
        return context.json({ request });
      } catch (error) {
        if (error instanceof SharedUseRequestDecidedError)
          return context.json({ error: error.message }, 409);
        throw error;
      }
    });
  }

  routes.post("/", async (context) => {
    const body = (await context.req.json().catch(() => null)) as {
      botId?: unknown;
      serverId?: unknown;
      reason?: unknown;
    } | null;
    const botId = typeof body?.botId === "string" ? body.botId : "";
    const serverId = typeof body?.serverId === "string" ? body.serverId : "";
    const reason =
      body?.reason === "trigger"
        ? "trigger"
        : body?.reason === "publish"
          ? "publish"
          : null;
    if (!botId || !serverId || !reason)
      return context.json({ error: "Name the Bot, the app and why." }, 400);
    if (!(await ownerOrAdmin(context.var.actor, botId)))
      return context.json({ error: "Only the Bot's owner can ask." }, 403);
    const held = await store.sharedAppsHeldBy(botId);
    if (!held.some((app) => app.serverId === serverId))
      return context.json(
        { error: "That Bot does not use that shared app." },
        400,
      );
    const filed = await store.fileRequest({
      botId,
      serverId,
      reason,
      requestedBy: context.var.actor.id,
      proposed: exposureOf(await store.botFacts(botId)),
    });
    if (filed.created) {
      await recordAuditEvent(audit, {
        eventType: "shared_use.requested",
        targetType: "mcp_server",
        targetId: serverId,
        actorUserId: context.var.actor.id,
        payload: { bot: botId, server: serverId, reason, request: filed.id },
      });
    }
    return context.json(filed);
  });

  routes.get("/bot/:botId", async (context) => {
    const botId = context.req.param("botId");
    if (!(await ownerOrAdmin(context.var.actor, botId)))
      return context.json({ error: "Only the Bot's owner can see this." }, 403);
    const needed = exposureOf(await store.botFacts(botId));
    const apps = await Promise.all(
      (await store.sharedAppsHeldBy(botId)).map(async (app) => {
        const approval = await store.approvalFor(botId, app.serverId);
        return { ...app, approval, needed, covered: covers(approval, needed) };
      }),
    );
    return context.json({ apps, pending: await store.pendingFor(botId) });
  });

  return routes;
}
