import { expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import type {
  BrowserChallenge,
  ComputerControlState,
} from "../../shared/computer-control";
import type { AppVariables } from "../src/auth/guards";
import { createComputerGateway } from "../src/computer/gateway";
import type { PolicyStore } from "../src/computer/policy-store";
import type { ComputerProvider } from "../src/computer/provider";
import { createComputerRoutes } from "../src/computer/routes";

const state: ComputerControlState = {
  holder: "bot",
  since: "2026-09-26T00:00:00Z",
  requested: true,
  transitioning: false,
  resumeSnapshotRequired: false,
  request: {
    id: "request-1",
    toolCallId: "call-1",
    source: "model",
    reason: "Sign in",
    status: "waiting",
    createdAt: "2026-09-26T00:00:00Z",
    updatedAt: "2026-09-26T00:00:00Z",
    expiresAt: "2026-09-26T00:10:00Z",
  },
};
function fixture(
  reply: (path: string, init?: RequestInit) => Response = () =>
    Response.json(state),
) {
  const requests: { path: string; init?: RequestInit }[] = [];
  const provider: ComputerProvider = {
    name: "fixture",
    isolation: "per-bot",
    locate: async () => "http://agent-computer:4100",
    status: async (botId) => ({ botId, state: "ready" }),
    stop: async () => ({ wasRunning: true }),
    reset: async () => ({ cleared: true }),
    list: async () => [],
  };
  const fetchImpl: typeof fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const path = `${url.pathname}${url.search}`;
      requests.push({ path, init });
      return reply(path, init);
    },
    { preconnect: fetch.preconnect },
  );
  const policy = { mode: "enforce" as const, deny: [], allow: ["true"] };
  const gateway = createComputerGateway({
    provider,
    fetchImpl,
    policy: () => policy,
    auditStore: { insert: async () => {} },
  });
  const policyStore: PolicyStore = {
    get: () => policy,
    set: async () => {},
    reset: async () => {},
    load: async () => "configuration",
    refresh: async () => {},
  };
  const user: MiddlewareHandler<{ Variables: AppVariables }> = async (
    context,
    next,
  ) => {
    context.set("actor", {
      id: "user-1",
      email: "test@example.com",
      role: "user",
    });
    await next();
  };
  const routes = createComputerRoutes(
    gateway,
    policyStore,
    user,
    async () => true,
  );
  const post = (path: string, body: unknown) =>
    routes.request(`http://app.test/bot-1${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  return { requests, routes, post };
}

test("request/rejoin and exact polling/take/release/cancel identities reach the computer", async () => {
  const { post, routes, requests } = fixture();
  expect(
    (
      await post("/control/request", {
        reason: "Sign in",
        toolCallId: "call-1",
      })
    ).status,
  ).toBe(200);
  expect(
    (await routes.request("http://app.test/bot-1/control?requestId=old%2Bid"))
      .status,
  ).toBe(200);
  for (const path of ["take", "release", "cancel"])
    expect(
      (await post(`/control/${path}`, { requestId: "request-1" })).status,
    ).toBe(200);
  expect(requests.map((r) => r.path)).toEqual([
    "/control/request",
    "/control?requestId=old%2Bid",
    "/control/take",
    "/control/release",
    "/control/cancel",
  ]);
  expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({
    reason: "Sign in",
    toolCallId: "call-1",
  });
  for (const request of requests.slice(2))
    expect(JSON.parse(String(request.init?.body))).toEqual({
      requestId: "request-1",
    });
  const count = requests.length;
  expect((await post("/control/take", {})).status).toBe(400);
  expect(requests).toHaveLength(count);
});

test("navigation carries tool identity and challenge; read and snapshot preserve challenge metadata", async () => {
  const challenge: BrowserChallenge = {
    kind: "cloudflare",
    reason: "Complete the challenge",
    requestId: "request-1",
  };
  const { post, routes, requests } = fixture((path) =>
    Response.json(
      path === "/snapshot"
        ? {
            snapshotId: 1,
            url: "https://example.com",
            title: "Challenge",
            elements: [],
            truncated: false,
            challenge,
          }
        : {
            url: "https://example.com",
            title: "Challenge",
            text: "Verify",
            truncated: false,
            elapsedMs: 1,
            challenge,
          },
    ),
  );
  const navigation = await post("/navigate", {
    url: "https://example.com",
    toolCallId: "call-1",
  });
  expect((await navigation.json()).challenge).toEqual(challenge);
  const sent = requests.find((r) => r.path === "/navigate");
  expect(JSON.parse(String(sent?.init?.body))).toEqual({
    url: "https://example.com/",
    toolCallId: "call-1",
  });
  expect(
    (await (await routes.request("http://app.test/bot-1/read")).json())
      .challenge,
  ).toEqual(challenge);
  expect((await (await post("/snapshot", {})).json()).challenge).toEqual(
    challenge,
  );
});

test("ownership, freshness, unknown ID and superseded ID survive transport and route shaping", async () => {
  for (const [status, body] of [
    [
      409,
      {
        error: "Wait",
        humanHasControl: true,
        requestId: "request-1",
        handoff: state.request,
      },
    ],
    [409, { error: "Snapshot required", stale: true, snapshotRequired: true }],
    [404, { error: "Unknown request", controlRequestError: true }],
    [409, { error: "Old request", controlRequestError: true }],
  ] as const) {
    const { post } = fixture(() => Response.json(body, { status }));
    const response = await post("/control/take", { requestId: "request-1" });
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual(body);
  }
});
