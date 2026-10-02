/**
 * The Bot profile's own routes: pause and resume, reset, notifications, update routing, Activity,
 * and the attention badges the sidebar draws.
 *
 * EVERYTHING HERE IS THE CALLER'S OWN. Each route acts on the signed-in person's relationship with a
 * Bot, never on the Bot for everybody: pausing a public coworker stops the work done in your name,
 * and resetting it forgets what it knew about you. The Bot must be one the caller can reach, asked
 * of the profile store the way every other Bot route asks; a Bot they cannot see is "not found".
 */
import type { Context, MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { ActivityStore } from "../activity/activity";
import type { AuditEventType, AuditStore } from "../audit";
import { recordAuditEvent } from "../audit";
import type { AppVariables } from "../auth/guards";
import {
  type BotLifecycleStore,
  type BotNotify,
  UPDATE_KINDS,
  UPDATE_TRANSPORTS,
  type UpdateKind,
  type UpdateTransport,
} from "./lifecycle";
import type { BotReset } from "./lifecycle-reset";
import type { AgentActor, AgentProfile } from "./profile-types";
import type { WakeUpStore } from "./wake-up";

/** The single-user developer's placeholder account, which has no users row to reference. */
const DEV_ACTOR_EMAIL = "dev@openbot.local";

const NOTIFY_VALUES: readonly BotNotify[] = ["all", "needs_input", "none"];

export type BotLifecycleServices = {
  lifecycle: BotLifecycleStore;
  reset: BotReset;
  activity: ActivityStore;
  wakeUps: WakeUpStore;
  profiles: {
    get(actor: AgentActor, id: string): Promise<AgentProfile | null>;
  };
  auditStore?: AuditStore;
};

export function createBotLifecycleRoutes(
  services: BotLifecycleServices,
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
) {
  const { lifecycle, reset, activity, wakeUps, profiles, auditStore } =
    services;
  const routes = new Hono<{ Variables: AppVariables }>();
  type C = Context<{ Variables: AppVariables }>;

  const record = async (
    context: C,
    eventType: Extract<AuditEventType, `bot.${string}`>,
    agentId: string,
    payload: Record<string, unknown> = {},
  ) => {
    if (!auditStore) return;
    const actor = context.var.actor;
    try {
      await recordAuditEvent(auditStore, {
        eventType,
        targetType: "agent",
        targetId: agentId,
        ...(actor?.id && actor.email !== DEV_ACTOR_EMAIL
          ? { actorUserId: actor.id }
          : {}),
        payload: { bot: agentId, actor: actor?.email ?? "unknown", ...payload },
      });
    } catch (error) {
      console.error(
        JSON.stringify({
          type: "bot-audit-write-failed",
          eventType,
          agentId,
          error: String(error),
        }),
      );
    }
  };

  /** The Bot, if the caller may reach it; otherwise the route has already answered 404. */
  const reachable = async (context: C): Promise<AgentProfile | Response> => {
    const agentId = context.req.param("agentId") ?? "";
    if (!agentId.trim())
      return context.json({ error: "A Bot id is required." }, 400);
    const agent = await profiles.get(context.var.actor, agentId);
    if (!agent) return context.json({ error: "Agent not found." }, 404);
    return agent;
  };

  const body = async (context: C) =>
    ((await context.req.json().catch(() => null)) ?? {}) as Record<
      string,
      unknown
    >;

  /** Every Bot that needs the caller, or has something unread, or is paused by them. */
  routes.get("/attention", requireUser, async (context) => {
    const ownerUserId = context.var.actor.id;
    const [counts, paused] = await Promise.all([
      activity.attention(ownerUserId),
      lifecycle.pausedFor(ownerUserId),
    ]);
    const ids = [...new Set([...counts.map((row) => row.agentId), ...paused])];
    const notify = await lifecycle.notifyFor(ownerUserId, ids);
    const byId = new Map(counts.map((row) => [row.agentId, row]));
    // Only Bots the caller can still reach: a count about a Bot they lost access to names it.
    const bots = [];
    for (const agentId of ids) {
      const agent = await profiles.get(context.var.actor, agentId);
      if (!agent) continue;
      const row = byId.get(agentId);
      bots.push({
        agentId,
        name: agent.name,
        questions: row?.questions ?? 0,
        approvals: row?.approvals ?? 0,
        handoffs: row?.handoffs ?? 0,
        unread: row?.unread ?? 0,
        paused: paused.includes(agentId),
        notify: notify[agentId] ?? "all",
      });
    }
    return context.json({ bots });
  });

  routes.get("/routing", requireUser, async (context) =>
    context.json({ routing: await lifecycle.routing(context.var.actor.id) }),
  );

  routes.put("/routing/:kind", requireUser, async (context) => {
    const kind = context.req.param("kind") as UpdateKind;
    if (!UPDATE_KINDS.includes(kind))
      return context.json({ error: "Unknown kind of update." }, 400);
    const { transports } = await body(context);
    const value =
      transports === "all"
        ? "all"
        : Array.isArray(transports) &&
            transports.every((transport) =>
              UPDATE_TRANSPORTS.includes(transport as UpdateTransport),
            )
          ? (transports as UpdateTransport[])
          : null;
    if (value === null)
      return context.json(
        { error: "Choose slack, sms and push, or all of them." },
        400,
      );
    await lifecycle.setRouting(context.var.actor.id, kind, value);
    return context.json({
      routing: await lifecycle.routing(context.var.actor.id),
    });
  });

  routes.get("/:agentId/lifecycle", requireUser, async (context) => {
    const agent = await reachable(context);
    if (agent instanceof Response) return agent;
    return context.json({
      lifecycle: await lifecycle.get(context.var.actor.id, agent.id),
    });
  });

  routes.post("/:agentId/pause", requireUser, async (context) => {
    const agent = await reachable(context);
    if (agent instanceof Response) return agent;
    const stopped = await lifecycle.pause(context.var.actor.id, agent.id);
    await record(context, "bot.paused", agent.id, { stoppedTurns: stopped });
    return context.json({
      lifecycle: await lifecycle.get(context.var.actor.id, agent.id),
      stoppedTurns: stopped,
    });
  });

  routes.post("/:agentId/resume", requireUser, async (context) => {
    const agent = await reachable(context);
    if (agent instanceof Response) return agent;
    await lifecycle.resume(context.var.actor.id, agent.id);
    await record(context, "bot.resumed", agent.id);
    return context.json({
      lifecycle: await lifecycle.get(context.var.actor.id, agent.id),
    });
  });

  routes.put("/:agentId/notifications", requireUser, async (context) => {
    const agent = await reachable(context);
    if (agent instanceof Response) return agent;
    const { notify } = await body(context);
    if (!NOTIFY_VALUES.includes(notify as BotNotify))
      return context.json({ error: "Choose all, needs_input or none." }, 400);
    await lifecycle.setNotify(
      context.var.actor.id,
      agent.id,
      notify as BotNotify,
    );
    await record(context, "bot.notifications_changed", agent.id, { notify });
    return context.json({
      lifecycle: await lifecycle.get(context.var.actor.id, agent.id),
    });
  });

  /** The notice: what a reset would delete, per kind, before anything is. */
  routes.get("/:agentId/reset", requireUser, async (context) => {
    const agent = await reachable(context);
    if (agent instanceof Response) return agent;
    return context.json({
      plan: await reset.plan(context.var.actor.id, agent.id),
    });
  });

  routes.post("/:agentId/reset", requireUser, async (context) => {
    const agent = await reachable(context);
    if (agent instanceof Response) return agent;
    const { confirm } = await body(context);
    if (confirm !== true)
      return context.json(
        { error: "A reset deletes data. Confirm it explicitly." },
        400,
      );
    const deleted = await reset.execute(context.var.actor, agent.id);
    await record(context, "bot.reset", agent.id, { deleted });
    return context.json({ deleted });
  });

  routes.get("/:agentId/activity", requireUser, async (context) => {
    const agent = await reachable(context);
    if (agent instanceof Response) return agent;
    return context.json({
      activity: await activity.forBot(context.var.actor.id, agent.id),
    });
  });

  routes.post(
    "/:agentId/activity/handoffs/stop",
    requireUser,
    async (context) => {
      const agent = await reachable(context);
      if (agent instanceof Response) return agent;
      const { id } = await body(context);
      if (typeof id !== "string" || !id)
        return context.json({ error: "Which delegated task?" }, 400);
      const stopped = await activity.stopHandoff(
        context.var.actor.id,
        agent.id,
        id,
      );
      if (!stopped)
        return context.json(
          { error: "That delegated task is not running or queued." },
          404,
        );
      await record(context, "bot.handoff_stopped", agent.id, {
        hop: stopped.key,
        to: stopped.toBotId,
      });
      return context.json({ stopped: true });
    },
  );

  routes.post("/:agentId/follow-ups/cancel", requireUser, async (context) => {
    const agent = await reachable(context);
    if (agent instanceof Response) return agent;
    const { id } = await body(context);
    if (typeof id !== "string" || !id)
      return context.json({ error: "Which follow-up?" }, 400);
    const cancelled = await wakeUps.cancel(context.var.actor.id, agent.id, id);
    if (!cancelled)
      return context.json(
        { error: "That follow-up has already run or was cancelled." },
        404,
      );
    return context.json({ cancelled: true });
  });

  return routes;
}
