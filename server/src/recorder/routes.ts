import {
  connectCodeRequestSchema,
  type ExchangeResponse,
  exchangeRequestSchema,
  type LearningSpaceState,
  RECORDER_ACTIVITY_STALE_MS,
  RECORDER_SIGNED_OUT,
  type RecorderConnection,
  type RecorderConnectionsResponse,
  type RecorderMe,
  type RecorderUser,
  recorderActivitySchema,
} from "@openbot/shared/recorder-api";
import { extensionIdFromOrigin } from "@openbot/shared/recorder-extension";
import { Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { type AuditStore, DEPLOYMENT_INITIATOR } from "../audit";
import type { AppVariables, AuthenticatedActor } from "../auth/guards";
import { reasonWithoutStatement } from "../db/query-failure";
import { recorderAudit, recorderConnected } from "./connected";
import type {
  RecorderConnectionStore,
  SealedOrganizationSession,
} from "./connections";
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
  /** The request's organization session cookie, sealed, with when that cookie expires. Null outside organization mode. */
  sealOrganizationSession: (
    cookieHeader: string | undefined,
  ) => Promise<SealedOrganizationSession | null>;
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

  /** Ends the connection with its row (connections.ts); `failed` when either could not be written, and then neither was. */
  async function revokeWithRow(
    userId: string,
    connectionId: string,
    reason: "disconnected" | "revoked",
  ): Promise<boolean | "failed"> {
    try {
      return await deps.connections.revoke(userId, connectionId, reason);
    } catch (error) {
      console.error(
        JSON.stringify({
          type: "recorder-revoke-failed",
          reason,
          // A failed query's message carries the values bound to it: never logged.
          error: reasonWithoutStatement(error),
        }),
      );
      return "failed";
    }
  }

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
        await audit({
          eventType: "recorder.connect_refused",
          targetType: "recorder_connection",
          actorUserId: context.var.actor.id,
          payload: { reason: "too_many_codes", via: body.data.via },
        });
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
        payload: { reason: "origin", origin: origin ?? null },
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
    let made: Awaited<ReturnType<RecorderConnectionStore["exchange"]>>;
    try {
      made = await deps.connections.exchange({
        code: body.data.code,
        label: body.data.label,
        installId: body.data.installId,
        extensionId,
      });
    } catch (error) {
      // The connection and its row are written together, so neither was: the code still stands, to be tried again.
      console.error(
        JSON.stringify({
          type: "recorder-connect-failed",
          error: reasonWithoutStatement(error),
        }),
      );
      return context.json(
        { error: "This browser could not be connected. Try again." },
        500,
      );
    }
    if (!made) {
      // Unknown, expired and already used look the same here: a used or expired code is deleted.
      await audit({
        eventType: "recorder.connect_refused",
        targetType: "recorder_connection",
        initiator: DEPLOYMENT_INITIATOR,
        payload: {
          reason: "code",
          extensionId,
          installId: body.data.installId,
        },
      });
      return context.json(
        {
          error:
            "This connection code has expired or was already used. Choose Connect this browser in OpenBot again.",
        },
        400,
      );
    }
    recorderConnected({ userId: made.userId, onConnected: deps.onConnected });
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

  // Settings, Browsers, which asks again while it is open: each live connection, and whether its Recorder is recording
  // now by its own latest report, which a recording sends every 30 s. Its last use cannot say so: a recording streams to
  // the gateway, and reaches OpenBot only with those reports.
  routes.get("/connections", deps.requireUser, async (context) => {
    const now = Date.now();
    const answer: RecorderConnectionsResponse = {
      connections: (await deps.connections.reporting(context.var.actor.id)).map(
        ({ activity, activityAt, ...connection }) => ({
          ...connection,
          recording:
            activity !== null &&
            activity.phase !== "idle" &&
            activityAt !== null &&
            now - activityAt.getTime() <= RECORDER_ACTIVITY_STALE_MS,
        }),
      ),
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
      if (!connectionId) {
        return context.json({ error: "This browser is not connected." }, 404);
      }
      const revoked = await revokeWithRow(
        context.var.actor.id,
        connectionId,
        "disconnected",
      );
      if (revoked === "failed") {
        return context.json(
          { error: "This browser could not be disconnected. Try again." },
          500,
        );
      }
      if (!revoked) {
        return context.json({ error: "This browser is not connected." }, 404);
      }
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
    if (!revoking) {
      return context.json({ error: "That connection was not found." }, 404);
    }
    const revoked = await revokeWithRow(userId, connectionId, "revoked");
    if (revoked === "failed") {
      return context.json(
        { error: "That browser could not be disconnected. Try again." },
        500,
      );
    }
    if (!revoked) {
      return context.json({ error: "That connection was not found." }, 404);
    }
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

  // What this browser's Recorder is doing now, which it says whenever its recording phase changes and every 30 s while
  // one runs: the Browser button's red dot reads it (browser/routes.ts), so the dot follows a recording in the person's
  // everyday browser as well as in the OpenBot browser. Kept against the connection, in place of the last report, and
  // never audited: it is a heartbeat, not a decision.
  routes.post(
    "/activity",
    deps.requireRecorder,
    jsonOnly,
    smallBody,
    async (context) => {
      const body = recorderActivitySchema.safeParse(
        await context.req.json().catch(() => null),
      );
      if (!body.success) {
        return context.json(
          { error: "That report of what is being recorded was not complete." },
          400,
        );
      }
      const connectionId = context.var.recorderConnectionId;
      // Revoked after the guard read its token: signed out, in the guard's own words, as the next request would be.
      if (
        !connectionId ||
        !(await deps.connections.reportActivity(
          context.var.actor.id,
          connectionId,
          body.data,
        ))
      ) {
        return context.json(
          {
            error:
              "This browser is no longer connected to OpenBot. Connect it again.",
            code: RECORDER_SIGNED_OUT,
            reason: "revoked",
          },
          401,
        );
      }
      return context.body(null, 204);
    },
  );

  return routes;
}
