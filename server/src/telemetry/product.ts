import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { MiddlewareFunction, RunAgentInput } from "@ag-ui/client";
import {
  isTelemetryDisabled,
  lambdaClient,
  type LambdaSendOptions,
} from "@copilotkit/shared";
import { concatMap, defer, finalize, from, switchMap, tap } from "rxjs";
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
export type ProductFailure =
  | "agent_error"
  | "stream_error"
  | "cancelled"
  | "timeout"
  | "missing_terminal";
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
export type ProductIdentity = { deploymentId: string; salt: string };
export type ProductRun = {
  actorUserId: string;
  threadId: string;
  context: ProductRunContext;
  acceptedAt: Date;
  terminalAt?: Date;
  outcome?: ProductOutcome;
  failureCategory?: ProductFailure;
  resultMessageIds: string[];
};
export type ProductEvent = {
  id: string;
  name: string;
  properties: Record<string, unknown>;
  createdAt: Date;
};
export type ProductStore = {
  identity(): Promise<ProductIdentity>;
  accept(run: ProductRun): Promise<ProductRun | null>;
  run(runId: string): Promise<ProductRun | null>;
  finish(
    runId: string,
    outcome: ProductOutcome,
    failure: ProductFailure | undefined,
    resultMessageIds: string[],
    at: Date,
  ): Promise<ProductRun | null>;
  linkResults(runId: string, resultMessageIds: string[]): Promise<void>;
  result(
    actorUserId: string,
    threadId: string,
    messageId: string,
  ): Promise<ProductRun | null>;
  event(event: ProductEvent): Promise<boolean>;
  pending(limit: number): Promise<ProductEvent[]>;
  deliver(id: string, send: () => Promise<void>): Promise<boolean>;
  prune(before: Date): Promise<void>;
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
      (v) => v === "true" || v === "1",
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
export function scopedProductUser(
  salt: string,
  deploymentId: string,
  actorUserId: string,
): string {
  return `ob_${createHmac("sha256", salt).update(`${deploymentId}\0${actorUserId}`).digest("hex")}`;
}
function stableId(value: string): string {
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
  attempted: ["mcp.account_connected"],
  completed: ["mcp.connection_verified", "mcp.account_disconnected"],
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
export type ProductHealth = {
  scope: "process";
  enabled: boolean;
  queued: number;
  attempted: number;
  dropped: number;
  failed: number;
  lastAttemptAt: string | null;
  transportAcknowledgesDelivery: false;
};
export type ProductTelemetry = Awaited<
  ReturnType<typeof createProductTelemetry>
>;
export async function createProductTelemetry(options: {
  store: ProductStore;
  env?: Record<string, string | undefined>;
  send?: (event: LambdaSendOptions) => Promise<void>;
  now?: () => Date;
  maxQueue?: number;
  warn?: (reason: string) => void;
}) {
  const env = options.env ?? process.env;
  const now = options.now ?? (() => new Date());
  const warn =
    options.warn ??
    ((reason) =>
      console.warn(JSON.stringify({ type: "product-telemetry", reason })));
  let enabled =
    productExportEnabled(env) &&
    !(env === process.env && isTelemetryDisabled());
  let identity: ProductIdentity | undefined;
  if (enabled)
    try {
      identity = await options.store.identity();
    } catch {
      enabled = false;
      warn("identity_unavailable");
    }
  const health: ProductHealth = {
    scope: "process",
    enabled,
    queued: 0,
    attempted: 0,
    dropped: 0,
    failed: 0,
    lastAttemptAt: null,
    transportAcknowledgesDelivery: false,
  };
  const queue: ProductEvent[] = [];
  const background = new Set<Promise<void>>();
  function track(work: Promise<void>) {
    background.add(work);
    void work
      .catch(() => report("background_failed"))
      .finally(() => background.delete(work));
  }
  let activeWrites = 0;
  const knownStops = new Map<string, "cancelled" | "timeout">();
  let draining: Promise<void> | undefined;
  const maxQueue = Math.max(1, Math.min(options.maxQueue ?? 256, 1024));
  const environment =
    env.NODE_ENV === "production"
      ? "production"
      : env.NODE_ENV === "test"
        ? "test"
        : env.NODE_ENV === "development"
          ? "development"
          : "unknown";
  function report(reason: string) {
    health.failed++;
    if (health.failed === 1 || health.failed % 100 === 0) warn(reason);
  }
  function enqueue(event: ProductEvent) {
    if (queue.some((e) => e.id === event.id)) return;
    if (queue.length >= maxQueue) {
      health.dropped++;
      if (health.dropped === 1 || health.dropped % 100 === 0)
        warn("queue_full");
      return;
    }
    queue.push(event);
    health.queued = queue.length;
    startDrain();
  }
  function startDrain() {
    if (draining) return;
    draining = (async () => {
      while (queue.length) {
        const event = queue.shift();
        health.queued = queue.length;
        if (!event) break;
        try {
          await options.store.deliver(event.id, async () => {
            await (options.send ?? lambdaClient.send)({
              event: event.name,
              properties: {
                ...event.properties,
                event_id: event.id,
                deployment_environment: environment,
                occurred_at: event.createdAt.toISOString(),
              },
              globalProperties: {
                app_id: "openbot",
                deployment_id: identity?.deploymentId,
                telemetry_emitter: "openbot",
                telemetry_transport: "lambda",
                sampleWeight: 1,
              },
              packageName: "@openbot/server",
              packageVersion: "0.2.0",
              telemetryId:
                env.CPK_TELEMETRY_ID ??
                env.COPILOTKIT_TELEMETRY_ID ??
                env.OPENBOT_INSTALL_ID,
              licenseToken: env.COPILOTKIT_LICENSE_TOKEN,
            });
            health.attempted++;
            health.lastAttemptAt = now().toISOString();
          });
        } catch {
          report("export_attempt_failed");
        }
      }
    })()
      .catch(() => report("drain_failed"))
      .finally(() => {
        draining = undefined;
        if (queue.length) startDrain();
      });
  }
  async function record(
    key: string,
    name: string,
    properties: Record<string, unknown>,
  ) {
    if (!enabled) return;
    if (queue.length + activeWrites >= maxQueue) {
      health.dropped++;
      if (health.dropped === 1 || health.dropped % 100 === 0)
        warn("queue_full");
      return;
    }
    activeWrites++;
    try {
      const event = {
        id: stableId(`${identity?.deploymentId}:${key}`),
        name: `oss.runtime.openbot.${name}`,
        properties,
        createdAt: now(),
      };
      if (await options.store.event(event)) enqueue(event);
    } catch {
      report("event_store_failed");
    } finally {
      activeWrites--;
    }
  }
  function user(actor: string) {
    return identity
      ? scopedProductUser(identity.salt, identity.deploymentId, actor)
      : undefined;
  }
  function sign(context: ProductRunContext, actor: string, thread: string) {
    return createHmac("sha256", identity?.salt ?? "")
      .update(JSON.stringify([context, actor, thread]))
      .digest("hex");
  }
  async function prepare(input: RunPreparation): Promise<unknown> {
    if (!enabled || !identity) return undefined;
    if (
      !boundedId.safeParse(input.threadId).success ||
      !boundedId.safeParse(input.runId).success
    ) {
      report("invalid_run_identifier");
      return undefined;
    }
    try {
      const parent = input.parentRunId
        ? await options.store.run(input.parentRunId)
        : null;
      const ownedParent =
        parent?.actorUserId === input.actorUserId ? parent : null;
      const context: ProductRunContext = {
        schema_version: 1,
        app_id: "openbot",
        deployment_id: identity.deploymentId,
        user_id: user(input.actorUserId) ?? "",
        root_task_id:
          ownedParent?.context.root_task_id ??
          (input.trigger === "human" || input.trigger === "routine"
            ? stableId(
                `${identity.deploymentId}:${input.actorUserId}:${input.rootTaskId ?? input.runId}`,
              )
            : null),
        run_id: input.runId,
        ...(ownedParent ? { parent_run_id: ownedParent.context.run_id } : {}),
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
      return {
        context,
        signature: sign(context, input.actorUserId, input.threadId),
      };
    } catch {
      report("context_prepare_failed");
      return undefined;
    }
  }
  function verified(
    value: unknown,
    actor: string,
    thread: string,
    run: string,
  ): ProductRunContext | undefined {
    if (
      !identity ||
      !value ||
      typeof value !== "object" ||
      !("context" in value) ||
      !("signature" in value) ||
      typeof value.signature !== "string" ||
      !/^[a-f0-9]{64}$/.test(value.signature)
    )
      return;
    const context = value.context;
    if (
      !context ||
      typeof context !== "object" ||
      !("run_id" in context) ||
      context.run_id !== run
    )
      return;
    const parsed = contextSchema.safeParse(context);
    if (!parsed.success) return;
    const expected = sign(parsed.data, actor, thread);
    if (
      value.signature.length !== expected.length ||
      !timingSafeEqual(Buffer.from(value.signature), Buffer.from(expected))
    )
      return;
    return parsed.data;
  }
  function middleware(actorUserId: string): MiddlewareFunction {
    return (input, next) =>
      defer(async () => {
        if (!enabled) return undefined;
        const context = verified(
          input.forwardedProps?.openbotTelemetry,
          actorUserId,
          input.threadId,
          input.runId,
        );
        if (!context) return undefined;
        try {
          const accepted = await options.store.accept({
            actorUserId,
            threadId: input.threadId,
            context,
            acceptedAt: now(),
            resultMessageIds: [],
          });
          if (!accepted) return undefined;
          await record(`accepted:${context.run_id}`, "run_accepted", {
            ...context,
            thread_id: input.threadId,
          });
          return accepted;
        } catch {
          report("run_store_failed");
          return undefined;
        }
      }).pipe(
        switchMap((run) => {
          let terminal: ProductOutcome | undefined;
          let failure: ProductFailure | undefined;
          const messages = new Set<string>();
          return next.run(input).pipe(
            tap({
              next: (event) => {
                if ("subagentRunId" in event && event.subagentRunId) return;
                if (
                  (event.type === "TEXT_MESSAGE_START" ||
                    event.type === "TEXT_MESSAGE_CHUNK") &&
                  "messageId" in event &&
                  typeof event.messageId === "string" &&
                  boundedId.safeParse(event.messageId).success &&
                  !("subagentRunId" in event && event.subagentRunId)
                )
                  messages.add(event.messageId);
                if (
                  event.type === "MESSAGES_SNAPSHOT" &&
                  "messages" in event &&
                  Array.isArray(event.messages)
                )
                  for (const message of event.messages)
                    if (
                      message?.role === "assistant" &&
                      typeof message.id === "string" &&
                      boundedId.safeParse(message.id).success &&
                      !message.subagentRunId &&
                      !input.messages.some((old) => old.id === message.id)
                    )
                      messages.add(message.id);
                if (event.type === "RUN_ERROR") {
                  terminal = "error";
                  failure = "agent_error";
                }
                if (event.type === "RUN_FINISHED" && terminal !== "error") {
                  const outcome =
                    "outcome" in event &&
                    event.outcome &&
                    typeof event.outcome === "object" &&
                    "type" in event.outcome
                      ? event.outcome.type
                      : undefined;
                  terminal =
                    outcome === "cancelled"
                      ? "cancelled"
                      : outcome === "interrupt"
                        ? "unknown"
                        : "success";
                }
              },
              error: () => {
                terminal = "error";
                failure = "stream_error";
              },
            }),
            concatMap((event) => {
              if (
                !run ||
                ("subagentRunId" in event && !!event.subagentRunId) ||
                !(event.type === "RUN_FINISHED" || event.type === "RUN_ERROR")
              )
                return from(Promise.resolve(event));
              return from(
                finish(run.context, terminal ?? "unknown", failure, [
                  ...messages,
                ]).then(() => event),
              );
            }),
            finalize(() => {
              if (run)
                track(
                  finish(
                    run.context,
                    terminal ?? "unknown",
                    failure ?? (terminal ? undefined : "missing_terminal"),
                    [...messages],
                  ).catch(() => report("terminal_store_failed")),
                );
            }),
          );
        }),
      );
  }
  async function finish(
    context: ProductRunContext,
    outcome: ProductOutcome,
    failure?: ProductFailure,
    resultMessageIds: string[] = [],
  ) {
    if (!enabled) return;
    const knownStop = knownStops.get(context.run_id);
    if (knownStop) {
      outcome = knownStop;
      failure = knownStop;
    }
    try {
      const ended = await options.store.finish(
        context.run_id,
        outcome,
        failure,
        resultMessageIds.slice(0, 256),
        now(),
      );
      if (!ended) {
        if (resultMessageIds.length)
          await options.store.linkResults(
            context.run_id,
            resultMessageIds.slice(0, 256),
          );
        return;
      }
      knownStops.delete(context.run_id);
      await record(`terminal:${context.run_id}`, "run_terminal", {
        ...context,
        thread_id: ended.threadId,
        outcome,
        failure_category: failure ?? "none",
        duration_ms: Math.max(
          0,
          (ended.terminalAt ?? now()).getTime() - ended.acceptedAt.getTime(),
        ),
        is_root:
          context.parent_run_id ||
          context.trigger === "subagent" ||
          context.trigger === "followup"
            ? false
            : context.trigger === "human" || context.trigger === "routine"
              ? true
              : null,
      });
      if (
        outcome === "success" &&
        context.trigger === "human" &&
        !context.parent_run_id &&
        context.purpose === "ordinary"
      )
        await record(
          `first_success:${context.user_id}`,
          "first_human_success",
          { ...context, thread_id: ended.threadId },
        );
    } catch {
      report("terminal_store_failed");
    }
  }
  async function consume(
    actor: string,
    event: ProductConsumption,
  ): Promise<"recorded" | "pending" | "missing"> {
    if (!enabled) return "pending";
    try {
      const run = await options.store.result(
        actor,
        event.threadId,
        event.messageId,
      );
      if (!run) return "pending";
      if (event.runId && event.runId !== run.context.run_id) return "missing";
      if (!run.terminalAt) return "pending";
      await record(
        `consume:${run.context.user_id}:${run.context.run_id}:${event.messageId}:${event.kind}`,
        event.kind,
        {
          ...run.context,
          thread_id: run.threadId,
          message_id: event.messageId,
          consumption_surface: event.surface,
          execution_outcome: run.outcome ?? "unknown",
        },
      );
      return "recorded";
    } catch {
      report("consumption_store_failed");
      return "pending";
    }
  }
  async function audit(event: AuditTapEvent) {
    const actorUserId =
      event.actorUserId ??
      (event.eventType.startsWith("mcp.") &&
      typeof event.payload.actor === "string" &&
      !["unattributed", "deployment"].includes(event.payload.actor)
        ? event.payload.actor
        : undefined);
    if (!enabled || !actorUserId || !event.id) return;
    const projected = projectAuditMilestone(event);
    if (!projected) return;
    const candidate =
      event.runId ??
      (typeof event.payload.runId === "string"
        ? event.payload.runId
        : typeof event.payload.run === "string"
          ? event.payload.run
          : undefined);
    let run: ProductRun | null = null;
    try {
      if (candidate) run = await options.store.run(candidate);
    } catch {
      report("audit_run_lookup_failed");
    }
    const context = run?.actorUserId === actorUserId ? run.context : undefined;
    await record(`audit:${event.id}`, "capability", {
      schema_version: 1,
      app_id: "openbot",
      deployment_id: identity?.deploymentId,
      user_id: user(actorUserId),
      environment,
      ...(context ?? {}),
      ...projected,
      source_event: event.eventType,
      initiator: boundedInitiator(event.initiatorKind),
    });
  }
  return {
    prepare,
    middleware,
    finish,
    consume,
    recordAudit: (event: AuditTapEvent) =>
      audit(event).catch(() => report("audit_projection_failed")),
    deploymentProperties: () => ({
      app_id: "openbot",
      ...(identity ? { deployment_id: identity.deploymentId } : {}),
    }),
    health: () => ({ ...health }),
    flush: async () => {
      while (background.size || draining) {
        await Promise.allSettled([...background]);
        await draining;
      }
    },
    start: async () => {
      if (!enabled) return;
      try {
        await options.store.prune(new Date(now().getTime() - 90 * 86400000));
        for (const event of await options.store.pending(maxQueue))
          enqueue(event);
      } catch {
        report("replay_failed");
      }
    },
    stopKnown: async (
      actor: string,
      runId: string,
      outcome: "cancelled" | "timeout",
    ) => {
      if (!enabled) return;
      knownStops.set(runId, outcome);
      const run = await options.store.run(runId).catch(() => {
        report("stop_context_unavailable");
        return null;
      });
      if (run?.actorUserId === actor)
        await finish(run.context, outcome, outcome);
      else knownStops.delete(runId);
    },
    enabled: () => enabled,
  };
}
function boundedInitiator(value: string): string {
  return [
    "person",
    "deployment",
    "routine",
    "responsibility",
    "memory",
    "handoff",
  ].includes(value)
    ? value
    : "unknown";
}
const contextSchema = z.strictObject({
  schema_version: z.literal(1),
  app_id: z.literal("openbot"),
  deployment_id: z.string(),
  user_id: z.string(),
  root_task_id: z.string().nullable(),
  run_id: z.string(),
  parent_run_id: z.string().optional(),
  attempt_id: z.string(),
  attempt: z.number().int().positive().max(10000).nullable(),
  trigger: z.enum(["human", "routine", "followup", "subagent", "unknown"]),
  surface: z.enum(["web", "desktop", "mobile", "external_channel", "unknown"]),
  environment: z.enum(["production", "development", "test", "unknown"]),
  purpose: z.enum(["ordinary", "setup", "unknown"]),
});
export function productRunForwardedProps(
  input: RunAgentInput,
  receipt: unknown,
) {
  return { ...input.forwardedProps, openbotTelemetry: receipt };
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
