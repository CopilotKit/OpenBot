import { expect, test } from "bun:test";
import type { AgentDriver, DriverEvent } from "../src/drivers/agent-driver";
import { createGatewayHandler } from "../src/server/app";

function driver() {
  let starts = 0;
  const value: AgentDriver = {
    provider: "fake",
    version: "1.0.0",
    async isAuthReady() {
      return true;
    },
    async *start() {
      starts += 1;
      for (const event of [] as DriverEvent[]) yield event;
    },
    async *resume() {
      starts += 1;
      for (const event of [] as DriverEvent[]) yield event;
    },
    async cancel() {},
  };
  return { value, starts: () => starts };
}

function runRequest(token?: string) {
  const headers = new Headers({ "content-type": "application/json" });
  if (token !== undefined) headers.set("x-openbot-agent-token", token);
  return new Request("http://gateway.test/ag-ui", {
    method: "POST",
    headers,
    body: JSON.stringify({
      threadId: "thread-1",
      runId: "run-1",
      messages: [],
      tools: [],
    }),
  });
}

test.each([undefined, "", "wrong-token"])(
  "rejects a missing or wrong managed token before calling the driver",
  async (token) => {
    const fake = driver();
    const handle = createGatewayHandler({
      token: "worker-secret",
      driver: fake.value,
    });

    const response = await handle(runRequest(token));

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Unauthorized." });
    expect(fake.starts()).toBe(0);
  },
);
