import { afterAll, beforeAll, expect, test } from "bun:test";
import type { RunAgentInput } from "@ag-ui/client";
import { type LambdaSendOptions, lambdaClient } from "@copilotkit/shared";
import { createActorAgentResolver } from "../src/agents/agent-resolver";
import { loadConfig } from "../src/config";
import { mountCopilotRuntime, registeredAgentFromRow } from "../src/copilot";
import { createProductTelemetry } from "../src/telemetry/product";
import { testEnvironment } from "./support/environment";

/**
 * CopilotKit's own runtime events, not OpenBot's product events, carry `app_id=openbot` always and
 * this deployment's ID only while OpenBot's product telemetry is on.
 *
 * Through the real runtime: the handler `mountCopilotRuntime` returns, answering a run request,
 * which the runtime records as `oss.runtime.copilot_request_created` with the properties OpenBot set
 * on it. What the runtime hands its telemetry transport is captured in place of the network send,
 * so nothing leaves this machine. The Intelligence platform is a fake on 127.0.0.1 that refuses
 * everything; the event is recorded before the run reaches it.
 */

const captured: LambdaSendOptions[] = [];
const transport = lambdaClient.send;
const disabled = {
  COPILOTKIT_TELEMETRY_DISABLED: process.env.COPILOTKIT_TELEMETRY_DISABLED,
  DO_NOT_TRACK: process.env.DO_NOT_TRACK,
};
let platform: ReturnType<typeof Bun.serve>;

beforeAll(() => {
  // The runtime records its events only where its own telemetry is not switched off.
  delete process.env.COPILOTKIT_TELEMETRY_DISABLED;
  delete process.env.DO_NOT_TRACK;
  lambdaClient.send = async (event) => {
    captured.push(event);
  };
  platform = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => Response.json({ error: "unavailable" }, { status: 503 }),
  });
});

afterAll(() => {
  lambdaClient.send = transport;
  platform.stop(true);
  for (const [name, value] of Object.entries(disabled))
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
});

async function until(done: () => boolean, what: string) {
  const deadline = Date.now() + 10_000;
  while (!done()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await Bun.sleep(10);
  }
}

/** The global properties on the runtime event recorded for one run request of a deployment. */
async function runtimeEventProperties(
  deploymentId: string,
  productEnv: Record<string, string>,
) {
  const productTelemetry = await createProductTelemetry({
    privacyKey: "synthetic-privacy-key",
    deploymentId,
    env: productEnv,
    send: async () => {},
  });
  const bot = registeredAgentFromRow({
    id: "standup",
    name: "Standup",
    type: "remote_ag_ui",
    configuration: { endpoint: `http://127.0.0.1:${platform.port}/ag-ui` },
    title: "Standup Bot",
    roleDescription: "Write the standup.",
  });
  if (!bot) throw new Error("the Bot did not parse");
  const runtime = mountCopilotRuntime(
    loadConfig(
      testEnvironment({
        INTELLIGENCE_API_URL: `http://127.0.0.1:${platform.port}`,
        INTELLIGENCE_GATEWAY_WS_URL: `ws://127.0.0.1:${platform.port}`,
      }),
    ),
    createActorAgentResolver({
      model: { provider: "openai", defaultModel: "unused" },
      loadAgents: async () => [bot],
      resolveModelApiKey: async () => null,
    }),
    async () => ({ id: "colleague", name: "Colleague" }),
    async () => ({ id: "colleague", role: "user" }),
    { productTelemetry },
  );
  const before = captured.length;
  await runtime.handler.fetch(
    new Request("http://127.0.0.1/api/copilotkit/agent/standup/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        threadId: `thread-${deploymentId}`,
        runId: `run-${deploymentId}`,
        state: {},
        messages: [{ id: "ask-1", role: "user", content: "Hello." }],
        tools: [],
        context: [],
        forwardedProps: {},
      } satisfies RunAgentInput),
    }),
  );
  const requested = () =>
    captured
      .slice(before)
      .find((event) => event.event === "oss.runtime.copilot_request_created");
  await until(() => requested() !== undefined, "the runtime's run event");
  return requested()?.globalProperties ?? {};
}

test("with product telemetry off, the runtime's events name the app and not the deployment", async () => {
  const properties = await runtimeEventProperties("dep_telemetry_off", {});
  expect(properties.app_id).toBe("openbot");
  expect(Object.values(properties)).not.toContain("dep_telemetry_off");
});

test("with product telemetry on, they carry the deployment's ID as before", async () => {
  const properties = await runtimeEventProperties("dep_telemetry_on", {
    OPENBOT_PRODUCT_TELEMETRY: "1",
  });
  expect(properties.app_id).toBe("openbot");
  expect(properties.deployment_id).toBe("dep_telemetry_on");
});
