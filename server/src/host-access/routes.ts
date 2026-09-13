import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { recordAuditEvent, type AuditStore } from "../audit";
import type { AppVariables } from "../auth/guards";
import { sameToken } from "../agents/callback-token";
import type { BotAccessCheck } from "../agents/profile-policy";
import { HostAccessRefusedError, type HostAccessBroker } from "./broker";
import {
  asHostAccessDesktopResult,
  HOST_ACCESS_DESKTOP_LEASE_MS,
} from "./schema";

function bearerToken(request: Request): string | null {
  const value = request.headers.get("authorization") ?? "";
  const [scheme, token] = value.split(/\s+/, 2);
  return scheme?.toLowerCase() === "bearer" && token ? token : null;
}

function desktopAuthorized(request: Request, token: string) {
  const given = bearerToken(request);
  return !!given && given.length === token.length && sameToken(given, token);
}

async function audit(
  auditStore: AuditStore | undefined,
  input: {
    actorUserId?: string;
    targetId?: string;
    change: string;
    botId?: string;
  },
) {
  if (!auditStore) return;
  await recordAuditEvent(auditStore, {
    eventType: "configuration.changed",
    targetType: "host_access",
    ...(input.targetId ? { targetId: input.targetId } : {}),
    ...(input.actorUserId ? { actorUserId: input.actorUserId } : {}),
    payload: input,
  });
}

export function createHostAccessRoutes(options: {
  broker: HostAccessBroker;
  desktopToken?: string;
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>;
  canUseBot: BotAccessCheck;
  auditStore?: AuditStore;
  botName?: (
    botId: string,
    actor: AppVariables["actor"],
  ) => Promise<string | null>;
}) {
  const routes = new Hono<{ Variables: AppVariables }>();
  const { broker, requireUser, canUseBot, auditStore } = options;

  const requireDesktop: MiddlewareHandler = async (context, next) => {
    const token = options.desktopToken;
    if (!token)
      return context.json(
        { error: "Desktop host access is not configured." },
        503,
      );
    if (!desktopAuthorized(context.req.raw, token)) {
      return context.json(
        { error: "Desktop host access authentication failed." },
        401,
      );
    }
    await next();
  };

  routes.get("/desktop/next", requireDesktop, (context) => {
    const next = broker.nextDesktopOperation();
    return context.json(
      next ?? { operations: [], leaseMs: HOST_ACCESS_DESKTOP_LEASE_MS },
    );
  });

  routes.post("/desktop/result", requireDesktop, async (context) => {
    const parsed = asHostAccessDesktopResult(
      await context.req.json().catch(() => null),
    );
    if (!parsed)
      return context.json(
        { error: "Send a valid desktop operation result." },
        400,
      );
    broker.resolveDesktopOperation(parsed);
    return context.json({ ok: true });
  });

  routes.get("/", requireUser, (context) =>
    context.json(broker.statusFor(context.var.actor.id)),
  );

  routes.post("/grants", requireUser, async (context) => {
    const body = (await context.req.json().catch(() => null)) as {
      botId?: unknown;
    } | null;
    if (typeof body?.botId !== "string" || !body.botId) {
      return context.json({ error: "botId is required." }, 400);
    }
    const actor = context.var.actor;
    if (!(await canUseBot(actor, body.botId))) {
      return context.json({ error: "That Bot is not available to you." }, 404);
    }
    try {
      const grant = await broker.requestFolderGrant({
        botId: body.botId,
        botName: (await options.botName?.(body.botId, actor)) ?? body.botId,
        actorId: actor.id,
      });
      await audit(auditStore, {
        actorUserId: actor.id,
        targetId: grant.id,
        change: "host_folder_granted",
        botId: body.botId,
      });
      return context.json({ grant });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "The folder was not granted.";
      return context.json(
        { error: message },
        error instanceof HostAccessRefusedError ? 409 : 500,
      );
    }
  });

  routes.delete("/grants/:id", requireUser, async (context) => {
    const actor = context.var.actor;
    try {
      broker.revokeGrant(context.req.param("id"), actor.id);
      await audit(auditStore, {
        actorUserId: actor.id,
        targetId: context.req.param("id"),
        change: "host_folder_revoked",
      });
      return context.json({ ok: true });
    } catch (error) {
      return context.json(
        {
          error:
            error instanceof Error
              ? error.message
              : "The folder grant could not be revoked.",
        },
        404,
      );
    }
  });

  routes.post("/stop", requireUser, async (context) => {
    const actor = context.var.actor;
    broker.stop(actor.id);
    await audit(auditStore, {
      actorUserId: actor.id,
      change: "host_access_stopped",
    });
    return context.json({ ok: true });
  });

  return routes;
}
