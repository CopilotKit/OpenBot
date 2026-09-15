import { describe, expect, test } from "bun:test";
import type { AgentDriver } from "../src/drivers/agent-driver";
import type { RunCounts } from "../src/observability/run-counts";
import { createGatewayHandler } from "../src/server/app";

function driver(authReady: boolean): AgentDriver {
  return {
    provider: "codex",
    version: "0.99.0",
    async isAuthReady() {
      return authReady;
    },
    async *start() {},
    async *resume() {},
    async cancel() {},
  };
}

const counts: RunCounts = {
  snapshot() {
    return { queueDepth: 2, activeRuns: 1 };
  },
  started() {},
  finished() {},
};

describe("gateway status", () => {
  test("health stays live without provider auth and exposes no auth path", async () => {
    const handle = createGatewayHandler({
      token: "worker-secret",
      driver: driver(false),
      counts,
    });

    const response = await handle(new Request("http://gateway.test/health"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      status: "ok",
      provider: "codex",
      version: "0.99.0",
      authReady: false,
      queueDepth: 2,
      activeRuns: 1,
    });
    expect(JSON.stringify(body)).not.toContain("path");
    expect(JSON.stringify(body)).not.toContain("credential");
  });

  test("readiness fails closed when provider auth is not ready", async () => {
    const handle = createGatewayHandler({
      token: "worker-secret",
      driver: driver(false),
      counts,
    });

    const response = await handle(new Request("http://gateway.test/ready"));

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      status: "not_ready",
      authReady: false,
    });
  });

  test("readiness succeeds when provider auth is ready", async () => {
    const handle = createGatewayHandler({
      token: "worker-secret",
      driver: driver(true),
      counts,
    });

    const response = await handle(new Request("http://gateway.test/ready"));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: "ready",
      authReady: true,
    });
  });
});
