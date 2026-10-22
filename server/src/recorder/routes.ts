import {
  connectCodeRequestSchema,
  type ExchangeResponse,
  exchangeRequestSchema,
  type LearningSpaceState,
  type RecorderConnection,
  type RecorderConnectionsResponse,
  type RecorderMe,
  type RecorderUser,
} from "@openbot/shared/recorder-api";
import { extensionIdFromOrigin } from "@openbot/shared/recorder-extension";
import { Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { type AuditStore, DEPLOYMENT_INITIATOR } from "../audit";
import type { AppVariables, AuthenticatedActor } from "../auth/guards";
import { recorderAudit, recorderConnected } from "./connected";
import type { RecorderConnectionStore } from "./connections";
import type { RecorderVariables } from "./variables";

export type RecorderRouteDeps = {
  connections: RecorderConnectionStore;
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>;
  requireRecorder: MiddlewareHandler<{ Variables: RecorderVariables }>;
  allowedExtensionIds: () => string[];
  /** Whether this person's recordings land in their own Learning space (made on first need). Never throws. */
  learningSpace: (actor: AuthenticatedActor) => Promise<LearningSpaceState>;
  /** A browser connected as this person: make their Learning space in the background. Never throws or waits. */
  onConnected?: (userId: string) => void;
  /** The person revoked one of their connections from OpenBot (Settings, Browsers): the browser holding it is told, where
   * OpenBot can reach it (their own OpenBot browser, browser/routes.ts). Awaited, briefly; never throws. */
  onRevoked?: (userId: string, connection: RecorderConnection) => Promise<void>;
  /** The name falls back to the email, never empty. */
  user: (userId: string) => Promise<RecorderUser | null>;
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
  const audit = recorderAudit(deps.auditStore);

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
      const minted = await deps.connections.mintCode(
        context.var.actor.id,
        body.data.via,
        sealed,
      );
      if (!minted) {
        return context.json(
          {
            error:
              "Too many connection codes were asked for at once. Wait a few minutes and try again.",
          },
          429,
        );
      }
      return context.json(minted, 201);
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
    await recorderConnected({ made, audit, onConnected: deps.onConnected });
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

  // The Recorder's own Disconnect above is not passed on: the browser that would be told is the one that asked, and it
  // forgets its connection itself, as the person's Disconnect rather than a sign-out.
  routes.delete("/connections/:id", deps.requireUser, async (context) => {
    const userId = context.var.actor.id;
    const connectionId = context.req.param("id");
    const revoking = (await deps.connections.list(userId)).find(
      (connection) => connection.id === connectionId,
    );
    if (!revoking || !(await deps.connections.revoke(userId, connectionId))) {
      return context.json({ error: "That connection was not found." }, 404);
    }
    await audit({
      eventType: "recorder.revoked",
      targetType: "recorder_connection",
      targetId: connectionId,
      actorUserId: userId,
      payload: { connectionId, reason: "revoked" },
    });
    await deps.onRevoked?.(userId, revoking);
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
    };
    return context.json(answer);
  });

  routes.get("/learning", deps.requireRecorder, async (context) =>
    context.json({ learning: await deps.learningSpace(context.var.actor) }),
  );

  return routes;
}
