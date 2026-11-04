import type { CopilotRuntimeHooks } from "@copilotkit/runtime/v2";
import type { createTurnRunner, TurnRunner } from "@openbot/toolkit/run-turn";
import type { IdentifyActor } from "../copilot";
import type { DeliveryInbox } from "../delivery/types";
import {
  appAnalyticsContext,
  type ProductTelemetry,
  productRunForwardedProps,
  type RunPreparation,
  triggerForInitiator,
} from "./product";

export function productRuntimeHook(
  telemetry: ProductTelemetry,
  identifyActor: IdentifyActor,
): NonNullable<CopilotRuntimeHooks["onBeforeHandler"]> {
  return ({ request, route }) =>
    route.method === "agent/run"
      ? prepareProductRequest(telemetry, identifyActor, request)
      : undefined;
}

/**
 * A browser run's request, with this deployment's context in its forwardedProps.
 *
 * Whatever the browser put under the same keys is replaced, and with telemetry off it is removed,
 * so the runtime's thread lock never carries a context this deployment did not state.
 */
export async function prepareProductRequest(
  telemetry: ProductTelemetry,
  identifyActor: IdentifyActor,
  request: Request,
): Promise<Request | undefined> {
  try {
    const body: unknown = await request.clone().json();
    if (
      !body ||
      typeof body !== "object" ||
      !("threadId" in body) ||
      typeof body.threadId !== "string" ||
      !("runId" in body) ||
      typeof body.runId !== "string"
    )
      return;
    const actor = await identifyActor(request);
    const messages =
      "messages" in body && Array.isArray(body.messages) ? body.messages : [];
    const lastUser = [...messages]
      .reverse()
      .find((m) => m?.role === "user" && typeof m.id === "string");
    const context = await telemetry.prepare({
      actorUserId: actor.id,
      threadId: body.threadId,
      runId: body.runId,
      rootTaskId: `${body.threadId}:${lastUser?.id ?? body.runId}`,
      trigger: "human",
      surface:
        process.env.OPENBOT_DISTRIBUTION === "desktop" ? "desktop" : "web",
    });
    return new Request(request, {
      body: JSON.stringify({
        ...body,
        forwardedProps: productRunForwardedProps(
          "forwardedProps" in body ? body.forwardedProps : undefined,
          context,
        ),
      }),
    });
  } catch {
    console.warn(
      JSON.stringify({
        type: "product-telemetry",
        reason: "request_context_unavailable",
      }),
    );
  }
}
export function productHeadlessBoundary(
  telemetry: ProductTelemetry,
): NonNullable<Parameters<typeof createTurnRunner>[0]["prepareRunInput"]> {
  return async (input, turn) => {
    const lineage = turn.telemetry;
    const context = await telemetry.prepare({
      actorUserId: turn.ownerUserId,
      threadId: input.threadId,
      runId: input.runId,
      trigger:
        lineage?.trigger ??
        (turn.continuation ? "followup" : triggerForInitiator(turn.initiator)),
      surface: lineage?.surface ?? "unknown",
      rootTaskId: lineage?.rootTaskId ?? `${turn.routineId}:${input.runId}`,
      // A resumed turn carries on the task the interrupted run was part of.
      inheritedRootTaskId:
        lineage?.inheritedRootTaskId ??
        telemetry.lineageOf(
          turn.ownerUserId,
          turn.continuation?.snapshot.forwardedProps,
        ).rootTaskId,
      parentRunId: lineage?.parentRunId ?? turn.continuation?.snapshot.runId,
      attempt: lineage?.attempt,
    });
    return {
      ...input,
      forwardedProps: productRunForwardedProps(input.forwardedProps, context),
    };
  };
}
function handoffPreparation(
  input: { threadId: string; runId: string },
  actorUserId: string,
  parentRunId: string,
): RunPreparation {
  return {
    actorUserId,
    threadId: input.threadId,
    runId: input.runId,
    parentRunId,
    trigger: "subagent",
    surface: "unknown",
  };
}
export async function productHandoffInput<
  Input extends { threadId: string; runId: string; forwardedProps: object },
>(
  telemetry: ProductTelemetry,
  input: Input,
  actorUserId: string,
  parentRunId: string,
) {
  const context = await telemetry.prepare(
    handoffPreparation(input, actorUserId, parentRunId),
  );
  return {
    ...input,
    forwardedProps: { ...input.forwardedProps, openbotTelemetry: context },
  };
}
/**
 * The analytics context for a Bot-to-Bot hop's thread lock, which is taken before the hop's run
 * input exists. The same derivation as {@link productHandoffInput}, so both describe one run.
 */
export async function productHandoffAnalyticsContext(
  telemetry: ProductTelemetry,
  input: { threadId: string; runId: string },
  actorUserId: string,
  parentRunId: string,
) {
  return appAnalyticsContext(
    await telemetry.prepare(
      handoffPreparation(input, actorUserId, parentRunId),
    ),
  );
}
/**
 * A delivered message's turn: a person wrote it, in the native app or on a chat or text platform
 * (Slack, Teams, SMS). Each message is its own task.
 */
export function deliveryLineage(
  source: DeliveryInbox["source"],
  runId: string,
): NonNullable<Parameters<TurnRunner>[0]["telemetry"]> {
  return {
    trigger: "human",
    surface: source === "native" ? "mobile" : "external_channel",
    rootTaskId: runId,
  };
}
