import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { sameToken } from "../agents/callback-token";
import type { BotAccessCheck } from "../agents/profile-policy";
import { type AuditStore, recordAuditEvent } from "../audit";
import type { AppVariables } from "../auth/guards";
import { type HostAccessBroker, HostAccessRefusedError } from "./broker";
import {
  asHostAccessDesktopResult,
  HOST_ACCESS_DESKTOP_LEASE_MS,
  type HostAccessRouteStatus,
} from "./schema";

/**
 * Said when a folder is asked for and no desktop can answer. Refused at once: queued, the request
 * waited for the operation's two minutes and then failed with the broker's expiry message.
 */
export const NO_DESKTOP_HOST =
  "Only OpenBot Desktop can open folders on this computer. This OpenBot isn't running in it.";
export const DESKTOP_HOST_OFFLINE =
  "The desktop app is offline. Open it, then choose the folder again.";

function bearerToken(request: Request): string | null {
  const value = request.headers.get("authorization") ?? "";
  const [scheme, token] = value.split(/\s+/, 2);
  return scheme?.toLowerCase() === "bearer" && token ? token : null;
}

function desktopAuthorized(request: Request, token: string) {
  const given = bearerToken(request);
  return !!given && given.length === token.length && sameToken(given, token);
}

/**
 * A person giving a Bot a folder, taking one away, or stopping folder access, on the trail with the
 * Bot (`bot`, which Activity's Bot column and its Bot filter read) and the folder by the name the
 * Computer page shows it under. Never the folder's path, which the desktop keeps to itself.
 */
async function audit(
  auditStore: AuditStore | undefined,
  input: {
    actorUserId: string;
    targetId?: string;
    change: string;
    bot?: string;
    folder?: string;
    folders?: string[];
  },
) {
  if (!auditStore) return;
  const { actorUserId, targetId, ...payload } = input;
  await recordAuditEvent(auditStore, {
    eventType: "configuration.changed",
    targetType: "host_access",
    ...(targetId ? { targetId } : {}),
    actorUserId,
    payload,
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
    context.json({
      ...broker.statusFor(context.var.actor.id),
      desktop: !!options.desktopToken,
    } satisfies HostAccessRouteStatus),
  );

  routes.post("/grants", requireUser, async (context) => {
    const body = (await context.req.json().catch(() => null)) as {
      botId?: unknown;
    } | null;
    // Whitespace-only is truthy and would pass to `canUseBot` (404) and the broker naming
    // nothing. Trimmed non-empty here, so malformed reads as malformed.
    const botId = typeof body?.botId === "string" ? body.botId.trim() : "";
    if (!botId) {
      return context.json({ error: "botId is required." }, 400);
    }
    const actor = context.var.actor;
    if (!(await canUseBot(actor, botId))) {
      return context.json({ error: "That Bot is not available to you." }, 404);
    }
    if (!options.desktopToken)
      return context.json({ error: NO_DESKTOP_HOST }, 409);
    if (!broker.statusFor(actor.id).connected)
      return context.json({ error: DESKTOP_HOST_OFFLINE }, 409);
    try {
      const grant = await broker.requestFolderGrant({
        botId,
        botName: (await options.botName?.(botId, actor)) ?? botId,
        actorId: actor.id,
      });
      await audit(auditStore, {
        actorUserId: actor.id,
        targetId: grant.id,
        change: "host_folder_granted",
        bot: botId,
        folder: grant.displayName,
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
    // The catch below maps every error to 404, so a malformed id would read as "not found"
    // instead of malformed. Checked here, before the broker or audit row.
    const id = context.req.param("id");
    if (!id.trim()) {
      return context.json({ error: "A grant id is required." }, 400);
    }
    try {
      const grant = broker.revokeGrant(id, actor.id);
      await audit(auditStore, {
        actorUserId: actor.id,
        targetId: id,
        change: "host_folder_revoked",
        bot: grant.botId,
        folder: grant.displayName,
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
    // The folders this ends, read before the broker marks them ended.
    const open = broker
      .statusFor(actor.id)
      .grants.filter((grant) => !grant.revoked);
    broker.stop(actor.id);
    const bots = new Set(open.map((grant) => grant.botId));
    await audit(auditStore, {
      actorUserId: actor.id,
      change: "host_access_stopped",
      ...(bots.size === 1 ? { bot: [...bots][0] } : {}),
      folders: open.map((grant) => grant.displayName),
    });
    return context.json({ ok: true });
  });

  return routes;
}
