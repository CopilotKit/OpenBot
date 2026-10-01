/**
 * Public ingress for registered triggers: `POST /api/events/triggers/:triggerId`.
 *
 * One URL shape for every secret-authenticated kind. The trigger row, not the request, decides which
 * vendor scheme applies, which owner the event belongs to and which responsibility it targets: a
 * payload can never choose its actor. Verification happens over the raw bytes before any parsing.
 *
 * Status codes: 200 means the delivery was authenticated and accepted (queued, or deliberately not
 * queued because the filter did not match — the body says which). It never means the run finished;
 * the run history on the responsibility is where the outcome lands. 401 bad signature, 404 unknown
 * trigger, 409 (generic webhook only) the responsibility is paused or completed, 413 body too large,
 * 503 the trigger is awaiting its provider secret.
 */
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { type AuditStore, recordAuditEvent } from "../audit";
import {
  linearTimestampFresh,
  verifyBearer,
  verifyGithubSignature,
  verifyLinearSignature,
  verifyPagerDutySignature,
  verifySentrySignature,
  verifyStandardWebhook,
} from "./signatures";
import {
  fitPayload,
  matchesFilter,
  type ResolvedTrigger,
  type TriggerDirectory,
} from "./triggers";
import type { ResponsibilityEvent, ResponsibilityEventResult } from "./types";

export const TRIGGER_BODY_LIMIT = 256 * 1024;

export type TriggerIngressDeps = {
  directory: TriggerDirectory;
  ingest: (event: ResponsibilityEvent) => Promise<ResponsibilityEventResult>;
  auditStore?: AuditStore;
  now?: () => number;
};
export type DeliveryOutcome =
  | ({ status: "queued" } & ResponsibilityEventResult)
  | { status: "ignored"; reason: string }
  | { status: "inactive"; reason: string };

/**
 * The one path every trigger kind (webhook, providers, email, Slack) takes after authentication:
 * lifecycle gate, narrow filter, then the store's transactional event + run + queue insert, audited
 * with the trigger source.
 */
export async function deliverToTrigger(
  deps: Pick<TriggerIngressDeps, "ingest" | "auditStore">,
  trigger: ResolvedTrigger,
  delivery: {
    deliveryId: string;
    type: string;
    payload: Record<string, unknown>;
  },
  filterPasses: boolean,
): Promise<DeliveryOutcome> {
  // Paused and completed responsibilities never run, however they are triggered. Nothing is
  // recorded for them, so resuming later does not replay what arrived while paused.
  if (!trigger.enabled)
    return { status: "inactive", reason: "This trigger is paused." };
  if (trigger.responsibilityStatus !== "active")
    return {
      status: "inactive",
      reason: `The responsibility is ${trigger.responsibilityStatus}.`,
    };
  if (!filterPasses)
    return { status: "ignored", reason: "The trigger's filter did not match." };
  const result = await deps.ingest({
    ownerUserId: trigger.ownerUserId,
    responsibilityId: trigger.responsibilityId,
    triggerId: trigger.id,
    source: trigger.kind,
    externalId: `${trigger.id}:${delivery.deliveryId}`.slice(0, 256),
    type: delivery.type.slice(0, 128) || "received",
    payload: fitPayload(delivery.payload),
  });
  if (deps.auditStore && !result.duplicate)
    await recordAuditEvent(deps.auditStore, {
      eventType: "responsibility.triggered",
      targetType: "responsibility",
      targetId: trigger.responsibilityId,
      actorUserId: trigger.ownerUserId,
      initiator: { kind: "responsibility", id: trigger.responsibilityId },
      payload: {
        source: trigger.kind,
        triggerId: trigger.id,
        eventType: delivery.type,
        deliveryId: delivery.deliveryId.slice(0, 256),
        eventId: result.eventId,
        runIds: result.runIds,
      },
    }).catch((error) =>
      console.error(
        JSON.stringify({
          type: "responsibility-trigger-audit-failed",
          triggerId: trigger.id,
          error: error instanceof Error ? error.message : String(error),
        }),
      ),
    );
  return { status: "queued", ...result };
}

function outcomeBody(outcome: DeliveryOutcome) {
  return outcome.status === "queued"
    ? {
        accepted: true,
        queued: outcome.runIds.length > 0,
        duplicate: outcome.duplicate,
        eventId: outcome.eventId,
        runIds: outcome.runIds,
      }
    : { accepted: true, queued: false, reason: outcome.reason };
}

function parseObject(raw: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(raw);
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
const str = (value: unknown) => (typeof value === "string" ? value : undefined);

export function createTriggerIngressRoutes(deps: TriggerIngressDeps) {
  const now = deps.now ?? Date.now;
  const routes = new Hono();
  routes.use(
    "*",
    bodyLimit({
      maxSize: TRIGGER_BODY_LIMIT,
      onError: (context) =>
        context.json({ error: "Event body is too large." }, 413),
    }),
  );
  routes.onError((error, context) => {
    console.error(
      JSON.stringify({
        type: "responsibility-trigger-error",
        errorType: error.name,
        error: error.message,
        timestamp: new Date().toISOString(),
      }),
    );
    return context.json(
      { error: "The event could not be accepted. Try again." },
      503,
    );
  });
  routes.post("/:triggerId", async (context) => {
    const trigger = await deps.directory.resolve(
      context.req.param("triggerId"),
    );
    if (!trigger || trigger.kind === "email" || trigger.kind === "slack")
      return context.json({ error: "Trigger not found." }, 404);
    if (!trigger.secret)
      return context.json(
        {
          error:
            "This trigger is waiting for its signing secret. Paste it on the responsibility.",
        },
        503,
      );
    const raw = await context.req.text();
    const header = (name: string) => context.req.header(name) ?? undefined;
    const unauthorized = () =>
      context.json({ error: "Invalid signature." }, 401);
    const deliver = async (
      delivery: {
        deliveryId: string;
        type: string;
        payload: Record<string, unknown>;
      },
      extraPass = true,
    ) => {
      const filter =
        trigger.config.kind === "slack" ? null : trigger.config.filter;
      const outcome = await deliverToTrigger(
        deps,
        trigger,
        delivery,
        extraPass &&
          (!filter || matchesFilter(filter, delivery.type, delivery.payload)),
      );
      if (outcome.status === "inactive" && trigger.kind === "webhook")
        return context.json(
          { error: outcome.reason, accepted: false, queued: false },
          409,
        );
      return context.json(outcomeBody(outcome), 200);
    };

    switch (trigger.kind) {
      case "webhook": {
        const signed = header("webhook-signature");
        const ok = signed
          ? verifyStandardWebhook(
              trigger.secret,
              raw,
              {
                id: header("webhook-id"),
                timestamp: header("webhook-timestamp"),
                signature: signed,
              },
              Math.floor(now() / 1000),
            )
          : verifyBearer(trigger.secret, header("authorization"));
        if (!ok) return unauthorized();
        const payload = raw.trim() ? parseObject(raw) : {};
        if (!payload)
          return context.json(
            { error: "Send a JSON object (or an empty body)." },
            400,
          );
        const idempotency = (
          header("idempotency-key") ?? header("webhook-id")
        )?.trim();
        if (idempotency && idempotency.length > 200)
          return context.json({ error: "Idempotency-Key is too long." }, 400);
        return deliver({
          deliveryId: idempotency || randomUUID(),
          type: str(payload.type) ?? str(payload.event) ?? "received",
          payload,
        });
      }
      case "github": {
        if (
          !verifyGithubSignature(
            trigger.secret,
            raw,
            header("x-hub-signature-256"),
          )
        )
          return unauthorized();
        const deliveryId = header("x-github-delivery")?.trim();
        const event = header("x-github-event")?.trim();
        if (
          !deliveryId ||
          deliveryId.length > 200 ||
          !event ||
          !/^[a-z_]{1,64}$/.test(event)
        )
          return context.json(
            { error: "GitHub event identity is required." },
            400,
          );
        const payload = parseObject(raw);
        if (!payload)
          return context.json(
            { error: "GitHub event is not valid JSON." },
            400,
          );
        if (event === "ping")
          return context.json({
            accepted: true,
            queued: false,
            reason: "ping",
          });
        const repository = (
          payload.repository as { full_name?: unknown } | undefined
        )?.full_name;
        if (
          trigger.config.kind === "github" &&
          trigger.config.repository &&
          (typeof repository !== "string" ||
            repository.toLowerCase() !==
              trigger.config.repository.toLowerCase())
        )
          return context.json(
            { error: "Repository is not registered for this trigger." },
            403,
          );
        const action = str(payload.action);
        return deliver({
          deliveryId,
          type: action ? `${event}.${action}` : event,
          payload,
        });
      }
      case "linear": {
        if (
          !verifyLinearSignature(
            trigger.secret,
            raw,
            header("linear-signature"),
          )
        )
          return unauthorized();
        const payload = parseObject(raw);
        if (!payload)
          return context.json(
            { error: "Linear event is not valid JSON." },
            400,
          );
        if (!linearTimestampFresh(payload.webhookTimestamp, now()))
          return context.json(
            { error: "Linear webhook timestamp is stale." },
            401,
          );
        const deliveryId = header("linear-delivery")?.trim();
        if (!deliveryId || deliveryId.length > 200)
          return context.json({ error: "Linear-Delivery is required." }, 400);
        const entity = str(payload.type) ?? header("linear-event") ?? "Event";
        const action = str(payload.action);
        return deliver({
          deliveryId,
          type: action ? `${entity}.${action}` : entity,
          payload,
        });
      }
      case "sentry": {
        if (
          !verifySentrySignature(
            trigger.secret,
            raw,
            header("sentry-hook-signature"),
          )
        )
          return unauthorized();
        const payload = parseObject(raw);
        if (!payload)
          return context.json(
            { error: "Sentry event is not valid JSON." },
            400,
          );
        const resource = header("sentry-hook-resource")?.trim() ?? "event";
        if (resource === "installation")
          return context.json({
            accepted: true,
            queued: false,
            reason: "installation",
          });
        const deliveryId = header("request-id")?.trim();
        if (!deliveryId || deliveryId.length > 200)
          return context.json({ error: "Request-ID is required." }, 400);
        const action = str(payload.action);
        return deliver({
          deliveryId,
          type: action ? `${resource}.${action}` : resource,
          payload,
        });
      }
      case "pagerduty": {
        if (
          !verifyPagerDutySignature(
            trigger.secret,
            raw,
            header("x-pagerduty-signature"),
          )
        )
          return unauthorized();
        const payload = parseObject(raw);
        const event = payload?.event as Record<string, unknown> | undefined;
        const deliveryId = str(event?.id);
        const type = str(event?.event_type);
        if (!payload || !event || !deliveryId || !type)
          return context.json(
            { error: "PagerDuty V3 event envelope is required." },
            400,
          );
        if (type === "pagey.ping")
          return context.json({
            accepted: true,
            queued: false,
            reason: "ping",
          });
        return deliver({ deliveryId, type, payload });
      }
    }
  });
  return routes;
}
