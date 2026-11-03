import type { CopilotRuntimeHooks } from "@copilotkit/runtime/v2";
import type { createTurnRunner } from "@openbot/toolkit/run-turn";
import type { IdentifyActor } from "../copilot";
import {
  productRunForwardedProps,
  triggerForInitiator,
  type ProductTelemetry,
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
    const receipt = await telemetry.prepare({
      actorUserId: actor.id,
      threadId: body.threadId,
      runId: body.runId,
      rootTaskId: `${body.threadId}:${lastUser?.id ?? body.runId}`,
      trigger: "human",
      surface:
        process.env.OPENBOT_DISTRIBUTION === "desktop" ? "desktop" : "web",
    });
    const forwardedProps =
      "forwardedProps" in body &&
      body.forwardedProps &&
      typeof body.forwardedProps === "object" &&
      !Array.isArray(body.forwardedProps)
        ? body.forwardedProps
        : {};
    return new Request(request, {
      body: JSON.stringify({
        ...body,
        forwardedProps: { ...forwardedProps, openbotTelemetry: receipt },
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
    const receipt = await telemetry.prepare({
      actorUserId: turn.ownerUserId,
      threadId: input.threadId,
      runId: input.runId,
      trigger:
        lineage?.trigger ??
        (turn.continuation ? "followup" : triggerForInitiator(turn.initiator)),
      surface: lineage?.surface ?? "unknown",
      rootTaskId: lineage?.rootTaskId ?? `${turn.routineId}:${input.runId}`,
      parentRunId: lineage?.parentRunId ?? turn.continuation?.snapshot.runId,
      attempt: lineage?.attempt,
    });
    return {
      ...input,
      forwardedProps: productRunForwardedProps(input, receipt),
    };
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
  const receipt = await telemetry.prepare({
    actorUserId,
    threadId: input.threadId,
    runId: input.runId,
    parentRunId,
    trigger: "subagent",
    surface: "unknown",
  });
  return {
    ...input,
    forwardedProps: { ...input.forwardedProps, openbotTelemetry: receipt },
  };
}
