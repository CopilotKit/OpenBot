import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import {
  clearDesktopConnectionFailure,
  mountDesktopConnectionFailure,
  recordDesktopConnectionFailure,
} from "../src/desktop-connection-failure";
import { createIntelligenceClient } from "../src/intelligence-client";

const hostToken = "intelligence-test-host-token";
const desktop = new Hono();
mountDesktopConnectionFailure(desktop, hostToken);
const servers: ReturnType<typeof Bun.serve>[] = [];

function platform() {
  let status = 401;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () =>
      Response.json(
        status === 200
          ? { threads: [], nextCursor: null }
          : { error: "fixture rejection" },
        { status },
      ),
  });
  servers.push(server);
  const client = createIntelligenceClient({
    apiUrl: server.url.origin,
    gatewayWsUrl: "ws://127.0.0.1:1",
    apiKey: "fixture-project-key",
  });
  return {
    client,
    respondWith(value: number) {
      status = value;
    },
  };
}

async function failure() {
  const response = await desktop.request("/api/desktop/connection-failure", {
    headers: { "x-openbot-desktop-host-token": hostToken },
  });
  return response.json();
}

beforeEach(() => {
  clearDesktopConnectionFailure("model");
  clearDesktopConnectionFailure("intelligence");
});
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop(true)));
  clearDesktopConnectionFailure("model");
  clearDesktopConnectionFailure("intelligence");
});

describe("Intelligence authentication recovery", () => {
  test("real SDK HTTP 401 preserves its error and signals focused native recovery", async () => {
    const { client } = platform();
    await expect(
      client.listThreads({ userId: "employee", agentId: "bot" }),
    ).rejects.toMatchObject({
      name: "PlatformRequestError",
      status: 401,
    });
    expect(await failure()).toEqual({
      connection: "intelligence",
      code: "intelligence_authentication_failed",
    });
  });

  test("permission and service failures do not request a new credential", async () => {
    const { client, respondWith } = platform();
    for (const status of [403, 404, 429, 500]) {
      respondWith(status);
      await expect(
        client.listThreads({ userId: "employee", agentId: "bot" }),
      ).rejects.toMatchObject({ status });
      expect(await failure()).toBeNull();
    }
  });

  test("successful authenticated traffic clears only the Intelligence failure", async () => {
    const { client, respondWith } = platform();
    await expect(
      client.listThreads({ userId: "employee", agentId: "bot" }),
    ).rejects.toMatchObject({ status: 401 });
    recordDesktopConnectionFailure({
      connection: "model",
      code: "provider_authentication_failed",
    });
    respondWith(200);
    expect(
      await client.listThreads({ userId: "employee", agentId: "bot" }),
    ).toEqual({ threads: [], nextCursor: null });
    expect(await failure()).toEqual({
      connection: "model",
      code: "provider_authentication_failed",
    });
  });

  test("observed methods retain the SDK private-field receiver and lifecycle callbacks", async () => {
    const { client, respondWith } = platform();
    respondWith(200);
    expect(client.ɵgetApiKey()).toBe("fixture-project-key");
    expect(client.ɵgetRunnerWsUrl()).toContain("127.0.0.1:1");
    const unsubscribe = client.onThreadCreated(() => {});
    expect(typeof unsubscribe).toBe("function");
    unsubscribe();
    const read = client.listThreads.bind(client);
    expect(await read({ userId: "employee", agentId: "bot" })).toEqual({
      threads: [],
      nextCursor: null,
    });
  });
});
