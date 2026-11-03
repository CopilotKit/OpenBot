/** Synthetic producer canary. No model, customer database, message content or licence required. */
import {
  AbstractAgent,
  type BaseEvent,
  EventType,
  type RunAgentInput,
} from "@ag-ui/client";
import { from, lastValueFrom, toArray } from "rxjs";
import { createProductTelemetry } from "../src/telemetry/product";

const canaryId =
  process.env.OPENBOT_CANARY_ID ??
  `openbot-canary-${new Date().toISOString().slice(0, 10)}`;
if (!/^[A-Za-z0-9_-]{1,100}$/.test(canaryId))
  throw new Error(
    "OPENBOT_CANARY_ID must be 1-100 letters, digits, underscores or hyphens",
  );
const telemetry = await createProductTelemetry({
  deploymentId: canaryId,
  privacyKey: "synthetic-canary-key",
  env: {
    OPENBOT_PRODUCT_TELEMETRY: "1",
    NODE_ENV: "test",
    CPK_TELEMETRY_ID: canaryId,
  },
});
class CanaryAgent extends AbstractAgent {
  run(input: RunAgentInput) {
    const events: BaseEvent[] = [
      {
        type: EventType.RUN_STARTED,
        threadId: input.threadId,
        runId: input.runId,
      },
      {
        type: EventType.TEXT_MESSAGE_START,
        messageId: `${canaryId}-message`,
        role: "assistant",
      },
      {
        type: EventType.RUN_FINISHED,
        threadId: input.threadId,
        runId: input.runId,
        outcome: { type: "success" },
      },
    ];
    return from(events);
  }
}
const actor = "synthetic-canary-user";
const context = await telemetry.prepare({
  actorUserId: actor,
  threadId: `${canaryId}-thread`,
  runId: `${canaryId}-run`,
  rootTaskId: `${canaryId}-root`,
  trigger: "human",
  surface: "web",
});
const input: RunAgentInput = {
  threadId: `${canaryId}-thread`,
  runId: `${canaryId}-run`,
  messages: [],
  state: {},
  tools: [],
  context: [],
  forwardedProps: { openbotTelemetry: context },
};
await lastValueFrom(
  telemetry.middleware(actor)(input, new CanaryAgent()).pipe(toArray()),
);
await telemetry.recordAudit({
  id: `${canaryId}-audit`,
  eventType: "mcp.call_succeeded",
  actorUserId: actor,
  targetType: "mcp",
  initiatorKind: "person",
  initiatorId: null,
  payload: { runId: input.runId },
});
await telemetry.consume(actor, {
  kind: "result_viewed",
  threadId: input.threadId,
  messageId: `${canaryId}-message`,
  surface: "web",
});
await telemetry.flush();
console.info(
  JSON.stringify({
    canary_id: canaryId,
    expected_events: [
      "run_accepted",
      "run_terminal",
      "capability",
      "result_viewed",
    ],
    delivery_status: "unconfirmed_until_received_payload_verified",
    query: `properties.deployment_id = '${canaryId}'`,
  }),
);
