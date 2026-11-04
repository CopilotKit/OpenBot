import {
  AbstractAgent,
  EventType,
  type BaseEvent,
  type RunAgentInput,
} from "@ag-ui/client";
import { from, lastValueFrom, toArray } from "rxjs";
import type {
  ProductTelemetry,
  ProductTrigger,
} from "../../src/telemetry/product";

export class ProductFixtureAgent extends AbstractAgent {
  constructor(private readonly events: BaseEvent[]) {
    super();
  }
  run(_input: RunAgentInput) {
    return from(this.events);
  }
  override clone() {
    return new ProductFixtureAgent([...this.events]);
  }
}
/** Execute a content-free, real middleware stream for contract tests and synthetic canaries. */
export async function observedProductRun(
  telemetry: ProductTelemetry,
  options: {
    actor?: string;
    run?: string;
    root?: string;
    parent?: string;
    attempt?: number;
    thread?: string;
    message?: string;
    trigger?: ProductTrigger;
    events?: BaseEvent[];
  } = {},
) {
  const actor = options.actor ?? "private-user-one";
  const runId = options.run ?? "run-one";
  const threadId = options.thread ?? "thread-one";
  const receipt = await telemetry.prepare({
    actorUserId: actor,
    threadId,
    runId,
    rootTaskId: options.root ?? "root-one",
    parentRunId: options.parent,
    attempt: options.attempt,
    trigger: options.trigger ?? "human",
    surface: "web",
  });
  const input: RunAgentInput = {
    threadId,
    runId,
    messages: [],
    state: {},
    tools: [],
    context: [],
    forwardedProps: { openbotTelemetry: receipt },
  };
  const events = options.events ?? [
    { type: EventType.RUN_STARTED, threadId, runId },
    {
      type: EventType.TEXT_MESSAGE_START,
      messageId: options.message ?? `message-${runId}`,
      role: "assistant",
    },
    {
      type: EventType.RUN_FINISHED,
      threadId,
      runId,
      outcome: { type: "success" },
    },
  ];
  await lastValueFrom(
    telemetry
      .middleware(actor)(input, new ProductFixtureAgent(events))
      .pipe(toArray()),
  );
  await telemetry.flush();
  return input;
}
