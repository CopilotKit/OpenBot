import { describe, expect, test } from "bun:test";
import type { AuditEventInput, AuditStore } from "../src/audit";
import { createComputerGateway } from "../src/computer/gateway";
import type { ComputerProvider } from "../src/computer/provider";

function setup() {
  const calls: string[] = [];
  const rows: AuditEventInput[] = [];
  const provider: ComputerProvider = {
    name: "test",
    isolation: "per-bot",
    describeIsolation: () => ({
      isolation: "one computer per Bot",
      note: "Test provider.",
    }),
    locate: async (botId) => {
      calls.push(`locate:${botId}`);
      return `http://${botId}.computer`;
    },
    status: async (botId) => {
      calls.push(`status:${botId}`);
      return { botId, state: "ready" };
    },
    stop: async (botId) => void calls.push(`stop:${botId}`),
    reset: async (botId) => void calls.push(`reset:${botId}`),
    list: async () => [
      {
        botId: "bot-1",
        status: "started",
        startedAt: "2026-08-20T12:00:00.000Z",
      },
    ],
  };
  const auditStore: AuditStore = {
    insert: async (event) => void rows.push(event),
  };
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const gateway = createComputerGateway({
    provider,
    auditStore,
    policy: () => ({ mode: "enforce", deny: [], allow: ["true"] }),
    token: "computer-secret",
    fetchImpl: (async (url: string, init?: RequestInit) => {
      requests.push({ url, init });
      return Response.json({ image: "aGVsbG8=", mimeType: "image/png" });
    }) as unknown as typeof fetch,
  });
  return { gateway, provider, calls, rows, requests };
}

const ACTOR = { id: "dev-local-user" };

describe("the provider-backed computer gateway", () => {
  test("exposes the provider and delegates address and status lookup", async () => {
    const { gateway, provider, calls } = setup();

    expect(gateway.provider).toBe(provider);
    expect(await gateway.locate("bot-1")).toBe("http://bot-1.computer");
    expect(await gateway.status("bot-1")).toEqual({
      botId: "bot-1",
      state: "ready",
    });
    expect(calls).toEqual(["locate:bot-1", "status:bot-1"]);
  });

  test("takes a screenshot through the located computer with its identity and token", async () => {
    const { gateway, requests } = setup();

    expect(await gateway.screenshot("bot-1")).toEqual({
      image: "aGVsbG8=",
      mimeType: "image/png",
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("http://bot-1.computer/screenshot");
    expect(requests[0]?.init?.headers).toMatchObject({
      "x-openbot-bot-id": "bot-1",
      "x-openbot-computer-token": "computer-secret",
    });
  });

  test("uses the provider for inventory and audited lifecycle actions", async () => {
    const { gateway, calls, rows } = setup();

    expect(await gateway.computers()).toEqual({
      isolation: "per-bot",
      computers: [
        {
          botId: "bot-1",
          running: true,
          startedAt: "2026-08-20T12:00:00.000Z",
          egress: null,
        },
      ],
    });
    expect(await gateway.stopComputer("computer-1", "bot-1", ACTOR)).toEqual({
      wasRunning: true,
    });
    expect(await gateway.resetComputer("computer-1", "bot-1", ACTOR)).toEqual({
      cleared: true,
    });
    expect(calls).toEqual(["stop:bot-1", "reset:bot-1"]);
    expect(rows.map((row) => row.eventType)).toEqual([
      "computer.stopped",
      "computer.reset",
    ]);
  });

  test("routes acting, control, file, secret, and human input calls through the gateway", async () => {
    const { gateway, requests } = setup();

    await gateway.key("bot-1", "bot-1", ACTOR, { key: "Tab" });
    await gateway.scroll("bot-1", "bot-1", ACTOR, { deltaY: 400 });
    await gateway.listFiles("bot-1", "bot-1", ACTOR, { path: "notes" });
    await gateway.control("bot-1");
    await gateway.requestHelp("bot-1", "bot-1", ACTOR, "Sign in");
    await gateway.takeControl("bot-1", "bot-1", ACTOR);
    await gateway.releaseControl("bot-1", "bot-1", ACTOR);
    await gateway.requestSecret("bot-1", "bot-1", ACTOR, {
      label: "Password",
      ref: "e1",
      snapshotId: 3,
    });
    await gateway.supplySecret("bot-1", "bot-1", ACTOR, "secret");
    await gateway.humanInput("bot-1", { kind: "click", x: 10, y: 20 });

    expect(requests.map(({ url }) => new URL(url).pathname)).toEqual([
      "/key",
      "/scroll",
      "/files/list",
      "/control",
      "/control/request",
      "/control/take",
      "/control/release",
      "/control/secret",
      "/human/secret",
      "/human/click",
    ]);
  });
});
