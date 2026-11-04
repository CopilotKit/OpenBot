import { createHash, createHmac } from "node:crypto";
import type { MiddlewareFunction, RunAgentInput } from "@ag-ui/client";
import {
  isTelemetryDisabled,
  type LambdaSendOptions,
  lambdaClient,
} from "@copilotkit/shared";
import { defer, finalize, switchMap, tap } from "rxjs";
import { z } from "zod";
import type { AuditInitiator, AuditTapEvent } from "../audit";

export type ProductTrigger =
  | "human"
  | "routine"
  | "followup"
  | "subagent"
  | "unknown";
export type ProductSurface =
  | "web"
  | "desktop"
  | "mobile"
  | "external_channel"
  | "unknown";
export type ProductOutcome =
  | "success"
  | "error"
  | "cancelled"
  | "timeout"
  | "unknown";
export type ProductRunContext = {
  schema_version: 1;
  app_id: "openbot";
  deployment_id: string;
  user_id: string;
  root_task_id: string | null;
  run_id: string;
  parent_run_id?: string;
  attempt_id: string;
  attempt: number | null;
  trigger: ProductTrigger;
  surface: ProductSurface;
  environment: "production" | "development" | "test" | "unknown";
  purpose: "ordinary" | "setup" | "unknown";
};
export type RunPreparation = {
  actorUserId: string;
  threadId: string;
  runId: string;
  rootTaskId?: string;
  parentRunId?: string;
  attempt?: number;
  trigger: ProductTrigger;
  surface: ProductSurface;
  purpose?: ProductRunContext["purpose"];
};
const boundedId = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9_:.-]+$/);
const consumptionSchema = z.strictObject({
  kind: z.enum(["result_viewed", "result_copied"]),
  threadId: boundedId,
  messageId: boundedId,
  runId: boundedId.optional(),
  surface: z.enum(["web", "desktop", "mobile"]),
});
export type ProductConsumption = z.infer<typeof consumptionSchema>;
export function parseConsumption(value: unknown): ProductConsumption | null {
  const parsed = consumptionSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
export function productExportEnabled(
  env: Record<string, string | undefined>,
): boolean {
  if (
    [env.DO_NOT_TRACK, env.COPILOTKIT_TELEMETRY_DISABLED].some(
      (value) => value === "1" || value === "true",
    )
  )
    return false;
  if (env.OPENBOT_PRODUCT_TELEMETRY !== undefined)
    return (
      env.OPENBOT_PRODUCT_TELEMETRY === "1" ||
      env.OPENBOT_PRODUCT_TELEMETRY === "true"
    );
  return env.OPENBOT_DISTRIBUTION === "desktop";
}
/** Reuses the deployment's existing required encryption key; no telemetry identity is created. */
export function scopedProductUser(
  key: string,
  deploymentId: string,
  actorUserId: string,
) {
  return `ob_${createHmac("sha256", key).update(`openbot-product\0${deploymentId}\0${actorUserId}`).digest("hex")}`;
}
function stableId(value: string) {
  return createHash("sha256").update(value).digest("hex");
}
type Milestone = {
  capability:
    | "connection"
    | "approval"
    | "bot"
    | "routine"
    | "computer"
    | "learning";
  stage: "setup" | "use" | "intervention";
  outcome:
    | "attempted"
    | "completed"
    | "failed"
    | "rejected"
    | "cancelled"
    | "requested";
  actor_kind: "human" | "automation" | "unknown";
};
const auditMilestones: Record<string, Milestone> = {};
function milestones(
  capability: Milestone["capability"],
  stage: Milestone["stage"],
  actor_kind: Milestone["actor_kind"],
  groups: Partial<Record<Milestone["outcome"], string[]>>,
) {
  for (const [outcome, names] of Object.entries(groups))
    for (const name of names ?? [])
      auditMilestones[name] = {
        capability,
        stage,
        outcome: outcome as Milestone["outcome"],
        actor_kind,
      };
}
milestones("connection", "setup", "human", {
  attempted: ["mcp.account_connected", "mcp.connection_verified"],
  completed: ["mcp.account_disconnected"],
  failed: ["mcp.authorization_unreconciled"],
  cancelled: ["mcp.authorization_cancelled"],
});
milestones("connection", "use", "automation", {
  completed: ["mcp.call_succeeded"],
  failed: ["mcp.call_failed"],
  rejected: ["mcp.call_rejected", "mcp.callback_refused"],
});
milestones("approval", "intervention", "automation", {
  requested: ["approval.evaluated"],
});
milestones("approval", "intervention", "human", {
  completed: ["approval.person_decided"],
});
milestones("approval", "intervention", "automation", {
  cancelled: ["approval.withdrawn"],
});
milestones("bot", "setup", "human", {
  completed: [
    "bot.created",
    "bot.duplicated",
    "bot.updated",
    "bot.paused",
    "bot.resumed",
    "bot.deleted",
  ],
  rejected: ["bot.isolation_refused"],
});
milestones("bot", "use", "automation", { rejected: ["bot.declined"] });
milestones("routine", "setup", "human", {
  completed: [
    "routine.created",
    "routine.updated",
    "routine.deleted",
    "routine.enabled_changed",
  ],
});
milestones("computer", "use", "automation", {
  attempted: ["computer.action_allowed"],
  failed: ["computer.action_failed"],
  rejected: ["computer.action_refused"],
  cancelled: ["computer.action_stopped", "computer.stopped"],
});
milestones("computer", "intervention", "human", {
  completed: [
    "computer.control_taken",
    "computer.control_released",
    "computer.secret_supplied",
    "computer.sign_in_completed",
  ],
  failed: ["computer.sign_in_failed"],
  cancelled: ["computer.help_cancelled", "computer.sign_in_cancelled"],
});
milestones("computer", "intervention", "automation", {
  requested: ["computer.secret_requested", "computer.sign_in_requested"],
});
milestones("computer", "intervention", "unknown", {
  requested: ["computer.help_requested"],
});
milestones("learning", "setup", "human", {
  completed: [
    "learning.sharing_changed",
    "learning.skill_opened",
    "learning.skill_closed",
  ],
});
export function projectAuditMilestone(
  event: Pick<AuditTapEvent, "eventType" | "payload">,
): Milestone | null {
  const found = auditMilestones[event.eventType];
  if (!found) return null;
  if (event.eventType === "mcp.connection_verified") {
    // The same audit name records a clean check, a failed named probe, or an
    // unchecked connection. The writers use a null action when no probe ran.
    const verified = event.payload.verified;
    const probeRan =
      typeof event.payload.action === "string" &&
      event.payload.action.trim().length > 0;
    return {
      ...found,
      outcome:
        verified === true
          ? "completed"
          : verified === false && probeRan
            ? "failed"
            : "attempted",
    };
  }
  if (event.eventType === "approval.person_decided") {
    const verdict = event.payload.decision ?? event.payload.effect;
    return { ...found, outcome: verdict === "deny" ? "rejected" : "completed" };
  }
  if (event.eventType === "approval.evaluated") {
    const outcome = event.payload.outcome;
    const verdict =
      outcome && typeof outcome === "object" && "behaviour" in outcome
        ? outcome.behaviour
        : undefined;
    return {
      ...found,
      outcome:
        verdict === "deny"
          ? "rejected"
          : verdict === "ask"
            ? "requested"
            : "attempted",
    };
  }
  return { ...found };
}

export type ProductTelemetry = Awaited<
  ReturnType<typeof createProductTelemetry>
>;
/** A thin best-effort adapter to the existing sink. No database, queue, replay or local first-use state. */
export async function createProductTelemetry(options: {
  privacyKey: string;
  deploymentId?: string;
  env?: Record<string, string | undefined>;
  send?: (event: LambdaSendOptions) => Promise<void>;
  now?: () => Date;
  warn?: (reason: string) => void;
}) {
  const env = options.env ?? process.env;
  const enabled =
    productExportEnabled(env) &&
    !(env === process.env && isTelemetryDisabled());
  const candidate = options.deploymentId ?? env.CPK_TELEMETRY_ID;
  const deploymentId = boundedId.safeParse(candidate).success
    ? (candidate ?? "unknown")
    : "unknown";
  const now = options.now ?? (() => new Date());
  const environment =
    env.NODE_ENV === "production"
      ? "production"
      : env.NODE_ENV === "development"
        ? "development"
        : env.NODE_ENV === "test"
          ? "test"
          : "unknown";
  const warn =
    options.warn ??
    ((reason) =>
      console.warn(JSON.stringify({ type: "product-telemetry", reason })));
  const pending = new Set<Promise<void>>();
  const warnings = new Map<string, number>();
  function report(reason: string) {
    const count = (warnings.get(reason) ?? 0) + 1;
    warnings.set(reason, count);
    if (count === 1 || count % 100 === 0) warn(reason);
  }
  const user = (actor: string) =>
    scopedProductUser(options.privacyKey, deploymentId, actor);
  function emit(
    name: string,
    key: string,
    properties: Record<string, unknown>,
  ): Promise<void> {
    if (!enabled) return Promise.resolve();
    if (pending.size >= 16) {
      report("in_flight_limit");
      return Promise.resolve();
    }
    const eventId = stableId(`${deploymentId}:${key}`);
    const send = Promise.resolve()
      .then(() =>
        (options.send ?? lambdaClient.send)({
          event: `oss.runtime.openbot.${name}`,
          properties: {
            schema_version: 1,
            app_id: "openbot",
            deployment_id: deploymentId,
            environment,
            deployment_environment: environment,
            ...properties,
            event_id: eventId,
            occurred_at: now().toISOString(),
          },
          packageName: "@openbot/server",
          packageVersion: "0.2.0",
          telemetryId: env.CPK_TELEMETRY_ID ?? env.COPILOTKIT_TELEMETRY_ID,
          licenseToken: env.COPILOTKIT_LICENSE_TOKEN,
        }),
      )
      .catch(() => report("send_failed"))
      .finally(() => pending.delete(send));
    pending.add(send);
    return send;
  }
  async function prepare(
    input: RunPreparation,
  ): Promise<ProductRunContext | undefined> {
    if (
      !enabled ||
      !boundedId.safeParse(input.threadId).success ||
      !boundedId.safeParse(input.runId).success
    )
      return;
    const userId = user(input.actorUserId);
    return {
      schema_version: 1,
      app_id: "openbot",
      deployment_id: deploymentId,
      user_id: userId,
      root_task_id:
        input.trigger === "human" || input.trigger === "routine"
          ? stableId(`${userId}:${input.rootTaskId ?? input.runId}`)
          : null,
      run_id: input.runId,
      ...(input.parentRunId && boundedId.safeParse(input.parentRunId).success
        ? { parent_run_id: input.parentRunId }
        : {}),
      attempt_id: input.runId,
      attempt:
        typeof input.attempt === "number" &&
        Number.isInteger(input.attempt) &&
        input.attempt > 0
          ? Math.min(input.attempt, 10000)
          : null,
      trigger: input.trigger,
      surface: input.surface,
      environment,
      purpose: input.purpose ?? "ordinary",
    };
  }
  function middleware(actorUserId: string): MiddlewareFunction {
    return (input, next) =>
      defer(async () => {
        const parsed = contextSchema.safeParse(
          input.forwardedProps?.openbotTelemetry,
        );
        const supplied =
          parsed.success &&
          parsed.data.user_id === user(actorUserId) &&
          parsed.data.deployment_id === deploymentId &&
          parsed.data.run_id === input.runId
            ? parsed.data
            : undefined;
        const context =
          supplied ??
          (await prepare({
            actorUserId,
            threadId: input.threadId,
            runId: input.runId,
            trigger: "unknown",
            surface: "unknown",
          }));
        return context;
      }).pipe(switchToRun(input, next));
    function switchToRun(
      input: RunAgentInput,
      next: Parameters<MiddlewareFunction>[1],
    ) {
      return switchMap((context: ProductRunContext | undefined) => {
        if (!context) return next.run(input);
        const started = now();
        let outcome: ProductOutcome = "unknown";
        let failure = "missing_terminal";
        const messageIds = new Set<string>();
        void emit(
          "run_accepted",
          `accepted:${context.user_id}:${input.threadId}:${input.runId}`,
          { ...context, thread_id: input.threadId },
        );
        return next.run(input).pipe(
          tap({
            next: (event) => {
              if ("subagentRunId" in event && event.subagentRunId) return;
              if (
                (event.type === "TEXT_MESSAGE_START" ||
                  event.type === "TEXT_MESSAGE_CHUNK") &&
                "messageId" in event &&
                boundedId.safeParse(event.messageId).success &&
                typeof event.messageId === "string" &&
                messageIds.size < 256
              )
                messageIds.add(event.messageId);
              if (
                event.type === "MESSAGES_SNAPSHOT" &&
                "messages" in event &&
                Array.isArray(event.messages)
              )
                for (const message of event.messages)
                  if (
                    messageIds.size < 256 &&
                    message?.role === "assistant" &&
                    !message.subagentRunId &&
                    typeof message.id === "string" &&
                    boundedId.safeParse(message.id).success &&
                    !input.messages.some((old) => old.id === message.id)
                  )
                    messageIds.add(message.id);
              if (event.type === "RUN_ERROR") {
                outcome = "error";
                failure = "agent_error";
              }
              if (event.type === "RUN_FINISHED" && outcome !== "error") {
                const value =
                  "outcome" in event &&
                  event.outcome &&
                  typeof event.outcome === "object" &&
                  "type" in event.outcome
                    ? event.outcome.type
                    : undefined;
                outcome =
                  value === "cancelled"
                    ? "cancelled"
                    : value === "interrupt"
                      ? "unknown"
                      : value === undefined || value === "success"
                        ? "success"
                        : "unknown";
                failure = value === "interrupt" ? "interrupted" : "none";
              }
            },
            error: () => {
              outcome = "error";
              failure = "stream_error";
            },
          }),
          finalize(() => {
            void emit(
              "run_terminal",
              `terminal:${context.user_id}:${input.threadId}:${input.runId}`,
              {
                ...context,
                thread_id: input.threadId,
                outcome,
                failure_category: failure,
                duration_ms: Math.max(0, now().getTime() - started.getTime()),
                result_message_ids: [...messageIds],
                is_root:
                  context.parent_run_id ||
                  context.trigger === "subagent" ||
                  context.trigger === "followup"
                    ? false
                    : context.trigger === "human" ||
                        context.trigger === "routine"
                      ? true
                      : null,
              },
            );
          }),
        );
      });
    }
  }
  async function recordAudit(event: AuditTapEvent) {
    if (!enabled || !event.id) return;
    const actor =
      event.actorUserId ??
      (event.eventType.startsWith("mcp.") &&
      typeof event.payload.actor === "string" &&
      !["unattributed", "deployment"].includes(event.payload.actor)
        ? event.payload.actor
        : undefined);
    const milestone = projectAuditMilestone(event);
    if (!actor || !milestone) return;
    const run =
      event.runId ??
      (typeof event.payload.runId === "string"
        ? event.payload.runId
        : typeof event.payload.run === "string"
          ? event.payload.run
          : undefined);
    await emit("capability", `audit:${event.id}`, {
      user_id: user(actor),
      ...milestone,
      source_event: event.eventType,
      initiator: [
        "person",
        "deployment",
        "routine",
        "responsibility",
        "memory",
        "handoff",
      ].includes(event.initiatorKind)
        ? event.initiatorKind
        : "unknown",
      ...(run && boundedId.safeParse(run).success ? { run_id: run } : {}),
      ...(event.threadId && boundedId.safeParse(event.threadId).success
        ? { thread_id: event.threadId }
        : {}),
    });
  }
  return {
    prepare,
    middleware,
    recordAudit,
    enabled: () => enabled,
    deploymentProperties: () => ({
      app_id: "openbot",
      deployment_id: deploymentId,
    }),
    flush: async () => {
      await Promise.allSettled([...pending]);
    },
    consume: async (actor: string, event: ProductConsumption) => {
      await emit(
        event.kind,
        `consume:${user(actor)}:${event.threadId}:${event.messageId}:${event.kind}`,
        {
          user_id: user(actor),
          thread_id: event.threadId,
          message_id: event.messageId,
          consumption_surface: event.surface,
          ...(event.runId ? { run_id: event.runId } : {}),
        },
      );
    },
    stopKnown: async (
      actor: string,
      runId: string,
      reason: "cancelled" | "timeout",
    ) => {
      if (boundedId.safeParse(runId).success)
        await emit(
          "run_stop_requested",
          `stop:${user(actor)}:${runId}:${reason}`,
          { user_id: user(actor), run_id: runId, stop_reason: reason },
        );
    },
  };
}
export function productRunForwardedProps(
  input: RunAgentInput,
  context: unknown,
) {
  return { ...input.forwardedProps, openbotTelemetry: context };
}
export function triggerForInitiator(
  initiator?: AuditInitiator,
): ProductTrigger {
  return initiator?.kind === "routine" || initiator?.kind === "responsibility"
    ? "routine"
    : initiator?.kind === "handoff"
      ? "subagent"
      : "unknown";
}
const contextSchema = z.strictObject({
  schema_version: z.literal(1),
  app_id: z.literal("openbot"),
  deployment_id: z.string(),
  user_id: z.string(),
  root_task_id: z.string().nullable(),
  run_id: boundedId,
  parent_run_id: boundedId.optional(),
  attempt_id: boundedId,
  attempt: z.number().int().positive().max(10000).nullable(),
  trigger: z.enum(["human", "routine", "followup", "subagent", "unknown"]),
  surface: z.enum(["web", "desktop", "mobile", "external_channel", "unknown"]),
  environment: z.enum(["production", "development", "test", "unknown"]),
  purpose: z.enum(["ordinary", "setup", "unknown"]),
});
