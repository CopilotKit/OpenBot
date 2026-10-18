import {
  connectCodeRequestSchema,
  type ExchangeResponse,
  exchangeRequestSchema,
  type RecorderBot,
  type RecorderConnectionsResponse,
  type RecorderMe,
  type RecorderUser,
} from "@openbot/shared/recorder-api";
import { extensionIdFromOrigin } from "@openbot/shared/recorder-extension";
import { Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
  type AuditStore,
  DEPLOYMENT_INITIATOR,
  recordAuditEvent,
} from "../audit";
import type { AppVariables, AuthenticatedActor } from "../auth/guards";
import type { RecorderConnectionStore } from "./connections";
import type { RecorderVariables } from "./variables";

export type RecorderRouteDeps = {
  connections: RecorderConnectionStore;
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>;
  requireRecorder: MiddlewareHandler<{ Variables: RecorderVariables }>;
  allowedExtensionIds: () => string[];
  listBots: (actor: AuthenticatedActor) => Promise<RecorderBot[]>;
  /** The name falls back to the email, never empty. */
  user: (userId: string) => Promise<RecorderUser | null>;
  capabilities: () => RecorderMe["capabilities"];
  /** Null outside organization mode. */
  sealOrganizationSession: (
    cookieHeader: string | undefined,
  ) => Promise<string | null>;
  auditStore?: AuditStore;
};

const BODY_LIMIT_BYTES = 2 * 1024;

/** A cross-site form can only send these three content types, so requiring JSON stops one. */
const jsonOnly: MiddlewareHandler = async (context, next) => {
  if (!context.req.header("content-type")?.startsWith("application/json")) {
    return context.json({ error: "Send the request as JSON." }, 415);
  }
  await next();
};

const smallBody = bodyLimit({
  maxSize: BODY_LIMIT_BYTES,
  onError: (context) =>
    context.json({ error: "That request is too large." }, 413),
});

export function createRecorderRoutes(deps: RecorderRouteDeps) {
  const routes = new Hono<{ Variables: RecorderVariables }>();
  const audit = (event: Parameters<typeof recordAuditEvent>[1]) =>
    deps.auditStore
      ? recordAuditEvent(deps.auditStore, event).catch((error: unknown) => {
          console.error(
            JSON.stringify({
              type: "recorder-audit-write-failed",
              eventType: event.eventType,
              error: String(error),
            }),
          );
        })
      : Promise.resolve();

  routes.post(
    "/connect-codes",
    deps.requireUser,
    jsonOnly,
    smallBody,
    async (context) => {
      const body = connectCodeRequestSchema.safeParse(
        await context.req.json().catch(() => null),
      );
      if (!body.success) {
        return context.json(
          { error: "Choose how this browser connects." },
          400,
        );
      }
      const sealed = await deps.sealOrganizationSession(
        context.req.header("cookie"),
      );
      return context.json(
        await deps.connections.mintCode(
          context.var.actor.id,
          body.data.via,
          sealed,
        ),
        201,
      );
    },
  );

  // The code is the credential here, so the only gate is who is asking: Chrome sets Origin and a page cannot forge it.
  routes.post("/connections", jsonOnly, smallBody, async (context) => {
    const origin = context.req.header("origin");
    const extensionId = extensionIdFromOrigin(
      origin,
      deps.allowedExtensionIds(),
    );
    if (!extensionId) {
      await audit({
        eventType: "recorder.connect_refused",
        targetType: "recorder_connection",
        initiator: DEPLOYMENT_INITIATOR,
        payload: { origin: origin ?? null },
      });
      return context.json(
        { error: "Only the OpenBot Recorder extension can finish connecting." },
        403,
      );
    }
    const body = exchangeRequestSchema.safeParse(
      await context.req.json().catch(() => null),
    );
    if (!body.success) {
      return context.json(
        { error: "The connection request was not complete." },
        400,
      );
    }
    const made = await deps.connections.exchange({
      code: body.data.code,
      label: body.data.label,
      installId: body.data.installId,
      extensionId,
    });
    if (!made) {
      return context.json(
        {
          error:
            "This connection code has expired or was already used. Choose Connect this browser in OpenBot again.",
        },
        400,
      );
    }
    await audit({
      eventType: "recorder.connected",
      targetType: "recorder_connection",
      targetId: made.connection.id,
      actorUserId: made.userId,
      payload: {
        connectionId: made.connection.id,
        via: made.connection.via,
        extensionId,
        installId: made.connection.installId,
        label: made.connection.label,
      },
    });
    if (made.replaced) {
      await audit({
        eventType: "recorder.revoked",
        targetType: "recorder_connection",
        targetId: made.replaced,
        actorUserId: made.userId,
        payload: { connectionId: made.replaced, reason: "replaced" },
      });
    }
    const user = await deps.user(made.userId);
    if (!user) {
      return context.json(
        { error: "This person could not be found. Try again." },
        500,
      );
    }
    const answer: ExchangeResponse = {
      token: made.token,
      connection: made.connection,
      user,
    };
    return context.json(answer, 201);
  });

  routes.get("/connections", deps.requireUser, async (context) => {
    const answer: RecorderConnectionsResponse = {
      connections: await deps.connections.list(context.var.actor.id),
      extensionIds: deps.allowedExtensionIds(),
    };
    return context.json(answer);
  });

  // Declared before `:id`, or "current" would be taken for a connection id.
  routes.delete(
    "/connections/current",
    deps.requireRecorder,
    async (context) => {
      const connectionId = context.var.recorderConnectionId;
      if (
        !connectionId ||
        !(await deps.connections.revoke(context.var.actor.id, connectionId))
      ) {
        return context.json({ error: "This browser is not connected." }, 404);
      }
      await audit({
        eventType: "recorder.revoked",
        targetType: "recorder_connection",
        targetId: connectionId,
        actorUserId: context.var.actor.id,
        payload: { connectionId, reason: "disconnected" },
      });
      return context.body(null, 204);
    },
  );

  routes.delete("/connections/:id", deps.requireUser, async (context) => {
    const connectionId = context.req.param("id");
    if (!(await deps.connections.revoke(context.var.actor.id, connectionId))) {
      return context.json({ error: "That connection was not found." }, 404);
    }
    await audit({
      eventType: "recorder.revoked",
      targetType: "recorder_connection",
      targetId: connectionId,
      actorUserId: context.var.actor.id,
      payload: { connectionId, reason: "revoked" },
    });
    return context.body(null, 204);
  });

  routes.get("/me", deps.requireRecorder, async (context) => {
    const actor = context.var.actor;
    const user = (await deps.user(actor.id)) ?? {
      id: actor.id,
      email: actor.email,
      name: actor.name?.trim() || actor.email,
    };
    const answer: RecorderMe = {
      user,
      connectionId: context.var.recorderConnectionId ?? "",
      capabilities: deps.capabilities(),
    };
    return context.json(answer);
  });

  routes.get("/bots", deps.requireRecorder, async (context) =>
    context.json({ bots: await deps.listBots(context.var.actor) }),
  );

  return routes;
}
