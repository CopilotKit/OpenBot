import type { DriverRun } from "../drivers/agent-driver";

export type GatewayRunInput = DriverRun & { tools: readonly unknown[] };

const ID = /^[A-Za-z0-9._:-]{1,200}$/;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function gatewayRunInput(value: unknown): GatewayRunInput | undefined {
  if (!record(value)) return undefined;
  if (typeof value.threadId !== "string" || !ID.test(value.threadId)) {
    return undefined;
  }
  if (typeof value.runId !== "string" || !ID.test(value.runId))
    return undefined;
  if (!Array.isArray(value.messages)) return undefined;
  if (value.tools !== undefined && !Array.isArray(value.tools))
    return undefined;
  if (value.context !== undefined && !Array.isArray(value.context))
    return undefined;
  if (value.state !== undefined && !record(value.state)) return undefined;
  if (value.forwardedProps !== undefined && !record(value.forwardedProps)) {
    return undefined;
  }

  return {
    threadId: value.threadId,
    runId: value.runId,
    messages: value.messages,
    tools: value.tools ?? [],
    context: value.context ?? [],
    state: value.state ?? {},
    forwardedProps: value.forwardedProps ?? {},
  };
}
