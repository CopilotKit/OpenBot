import { expect, test } from "bun:test";
import { EventType, type RunAgentInput } from "@ag-ui/client";
import { lastValueFrom, toArray } from "rxjs";
import { CloningRemoteAgent } from "@openbot/toolkit/copilotkit/agents";
import { ProductFixtureAgent } from "../scripts/support/product-run";
import { productStoreFixture } from "../scripts/support/product-store";
import { createProductTelemetry } from "../src/telemetry/product";
import {
  prepareProductRequest,
  productHeadlessBoundary,
} from "../src/telemetry/product-boundaries";

async function fixture(deploymentId = "deployment") {
  const f = productStoreFixture({ deploymentId, salt: `salt-${deploymentId}` });
  const telemetry = await createProductTelemetry({
    store: f.store,
    env: { OPENBOT_PRODUCT_TELEMETRY: "1" },
    send: async () => {},
  });
  return { ...f, telemetry };
}
const input: RunAgentInput = {
  threadId: "thread",
  runId: "run",
  messages: [{ id: "ask", role: "user", content: "private prompt" }],
  context: [],
  tools: [],
  state: {},
  forwardedProps: { openbotTelemetry: { forged: true } },
};
const events = [
  {
    type: EventType.RUN_FINISHED,
    threadId: "thread",
    runId: "run",
    outcome: { type: "success" },
  },
] as const;
test("request boundary replaces client claims, preserves application fields and joins retries by last ask", async () => {
  const f = await fixture();
  const request = () =>
    new Request("https://openbot.test/api/copilotkit/agent/bot/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
  const actor = async () => ({ id: "actor", role: "user" as const });
  const first = await prepareProductRequest(f.telemetry, actor, request());
  const second = await prepareProductRequest(f.telemetry, actor, request());
  expect(first).toBeDefined();
  const body = await first!.json();
  const retry = await second!.json();
  expect(body.forwardedProps.openbotTelemetry.forged).toBeUndefined();
  expect(body.forwardedProps.openbotTelemetry.context.app_id).toBe("openbot");
  expect(body.forwardedProps.openbotTelemetry.context.root_task_id).toBe(
    retry.forwardedProps.openbotTelemetry.context.root_task_id,
  );
  expect(body.messages).toEqual(input.messages);
});
test("signed run context cannot cross actors, deployments or threads", async () => {
  const f = await fixture();
  const enriched = await productHeadlessBoundary(f.telemetry)(input, {
    ownerUserId: "actor-one",
    routineId: "routine",
    agentId: "bot",
    threadId: "thread",
    instruction: "private",
    telemetry: { trigger: "human" },
  });
  const next = new ProductFixtureAgent([...events]);
  await lastValueFrom(
    f.telemetry.middleware("actor-two")(enriched, next).pipe(toArray()),
  );
  const other = await fixture("another-deployment");
  await lastValueFrom(
    other.telemetry.middleware("actor-one")(enriched, next).pipe(toArray()),
  );
  await lastValueFrom(
    f.telemetry
      .middleware("actor-one")({ ...enriched, threadId: "other-thread" }, next)
      .pipe(toArray()),
  );
  expect(f.runs.size).toBe(0);
  expect(other.runs.size).toBe(0);
});
test("custom remote clone retains product middleware and full forwarded context", async () => {
  const f = await fixture();
  const enriched = await productHeadlessBoundary(f.telemetry)(input, {
    ownerUserId: "actor",
    routineId: "routine",
    agentId: "bot",
    threadId: "thread",
    instruction: "private",
    telemetry: { trigger: "routine" },
  });
  const remote = new ProductFixtureAgent([
    { type: EventType.RUN_STARTED, threadId: "thread", runId: "run" },
    ...events,
  ]);
  const wrapped = new CloningRemoteAgent(remote, () => {});
  wrapped.use(f.telemetry.middleware("actor"));
  const clone = wrapped.clone();
  clone.threadId = "thread";
  await clone.runAgent({
    runId: "run",
    forwardedProps: enriched.forwardedProps,
  });
  await f.telemetry.flush();
  expect(f.runs.get("run")?.context.trigger).toBe("routine");
  expect(f.runs.get("run")?.outcome).toBe("success");
});
