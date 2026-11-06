import { afterEach, expect, mock, spyOn, test } from "bun:test";
import {
  CopilotIntelligenceRuntime,
  CopilotKitIntelligence,
  createCopilotRuntimeHandler,
} from "@copilotkit/runtime/v2";
import { clearDesktopConnectionFailure } from "../src/desktop-connection-failure";
import {
  createIntelligenceClient,
  observeIntelligenceAuthentication,
} from "../src/intelligence-client";
import { createIntelligenceMemory } from "../src/memory/intelligence";
import {
  createSelfHostBanner,
  type RuntimeEntitlementResponse,
} from "../src/self-host-banner";

const RUNTIME_KEY =
  "cpk-openbot_abcdefgh12345678_abcdefghijklmnopqrstuvwxyz012345";

/**
 * `resolveSelfHostedEntitlements` (apps/app-api/src/routes/entitlements-routes.ts) for a valid
 * enterprise licence: boolean claims become features, numeric ones limits.
 */
const READY: RuntimeEntitlementResponse = {
  status: "ready",
  entitlement: {
    active: true,
    source: "selfHostedDeploymentLicense",
    features: { memory: true, learning: true },
    limits: { "threads.retention_hours": 720 },
    planCode: "enterprise",
    entitlementSource: "enterprise_override",
  },
};

/**
 * Intelligence over real HTTP, as a first install of OpenBot's Helm bundle meets it: until `up`,
 * every request fails on a table its migrations have not made yet, and Express answers 500 with
 * `createErrorResponseBody` (apps/app-api/src/errors/http-error-response.ts); then the entitlement
 * route answers, and memory has nothing stored.
 */
function startingIntelligence() {
  const state = { up: false };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      if (!state.up)
        return Response.json(
          {
            error: {
              code: "INTERNAL_SERVER_ERROR",
              message: "Unexpected server error.",
              category: "internal",
              retryable: true,
            },
            requestId: "request-test",
            traceId: "trace-test",
          },
          { status: 500 },
        );
      const path = new URL(request.url).pathname;
      if (path === "/api/entitlements/runtime") return Response.json(READY);
      if (path.startsWith("/api/memories"))
        return Response.json({ memories: [] });
      return Response.json(
        { error: { code: "ROUTE_NOT_FOUND" } },
        { status: 404 },
      );
    },
  });
  const settings = {
    apiUrl: `http://127.0.0.1:${server.port}`,
    gatewayWsUrl: "ws://127.0.0.1:9",
    apiKey: RUNTIME_KEY,
  };
  return { state, settings, stop: () => server.stop(true) };
}

const stops: (() => void)[] = [];
const telemetry = process.env.COPILOTKIT_TELEMETRY_DISABLED;
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  mock.restore();
  clearDesktopConnectionFailure("intelligence");
  if (telemetry === undefined) delete process.env.COPILOTKIT_TELEMETRY_DISABLED;
  else process.env.COPILOTKIT_TELEMETRY_DISABLED = telemetry;
});

/*
 * Kink 17 of the Helm bundle build, after the boot check was made to wait. OpenBot's server is up
 * before Intelligence's migrations finish, and the runtime client prints every failed entitlement
 * read as a multi-line `Runtime entitlement request failed` object. The boot check no longer asked
 * the client too early, but every other reader still did: the setup checklist reads at boot through
 * the same client as the self-host banner, memory reads on a turn, and the runtime's own `/info` on
 * every page load. Each is built here the way the server builds it, against real HTTP.
 */
test("while Intelligence is starting, no reader prints the runtime client's failed read, and each reads the answer once it is up", async () => {
  process.env.COPILOTKIT_TELEMETRY_DISABLED = "true";
  const intelligence = startingIntelligence();
  stops.push(intelligence.stop);
  const printed = spyOn(console, "error").mockImplementation(() => {});
  const { settings } = intelligence;

  // index.ts: the client the boot check, the setup checklist and the self-host banner read through.
  const shared = createIntelligenceClient(settings);
  const banner = createSelfHostBanner({
    enabled: true,
    entitlements: () => shared.getRuntimeEntitlements(),
    waitMs: 5_000,
    failureTtlMs: 0,
    log: () => {},
  });
  // index.ts: memory's own client.
  const memory = createIntelligenceMemory({
    client: createIntelligenceClient(settings),
    log: () => {},
  });
  // copilot.ts: the runtime's client, which its `/info` reads entitlements through.
  const runtime = new CopilotIntelligenceRuntime({
    intelligence: observeIntelligenceAuthentication(
      new CopilotKitIntelligence({
        apiUrl: settings.apiUrl,
        wsUrl: settings.gatewayWsUrl,
        apiKey: settings.apiKey,
      }),
    ),
    agents: {},
    identifyUser: () => ({ id: "person", name: "Person" }),
  });
  const handler = createCopilotRuntimeHandler({
    runtime,
    basePath: "/api/copilotkit",
  });
  const failedReads = () =>
    printed.mock.calls.filter((call) =>
      call.some(
        (part) =>
          typeof part === "string" &&
          part.includes("Runtime entitlement request failed"),
      ),
    );
  const info = async () =>
    (
      (await (
        await handler(new Request("http://127.0.0.1/api/copilotkit/info"))
      ).json()) as { runtimeEntitlements?: unknown }
    ).runtimeEntitlements;

  // Still starting: every reader is refused the way the client refuses, and nothing is printed.
  const refused = (await shared
    .getRuntimeEntitlements()
    .catch((error: unknown) => error)) as Record<string, unknown>;
  expect([refused.name, refused.status, refused.retryable]).toEqual([
    "PlatformRequestError",
    500,
    true,
  ]);
  expect(await banner.shown()).toBe(true);
  expect(await memory.available()).toBe(false);
  expect(await info()).toMatchObject({ status: "unavailable" });
  expect(failedReads()).toEqual([]);

  // Up: the same readers read the answer.
  intelligence.state.up = true;
  expect(await shared.getRuntimeEntitlements()).toEqual(READY);
  expect(await info()).toEqual(READY);
  // The banner answers from what it last heard and refreshes behind it, so its next answer is the new one.
  let shown = await banner.shown();
  for (let i = 0; i < 100 && shown; i++) {
    await Bun.sleep(10);
    shown = await banner.shown();
  }
  expect(shown).toBe(false);
  expect(failedReads()).toEqual([]);
});

test("once Intelligence has answered, a later failure is the client's to print", async () => {
  const intelligence = startingIntelligence();
  stops.push(intelligence.stop);
  const printed = spyOn(console, "error").mockImplementation(() => {});
  intelligence.state.up = true;
  const client = createIntelligenceClient(intelligence.settings);
  expect(await client.getRuntimeEntitlements()).toEqual(READY);
  intelligence.state.up = false;
  // Past the client's own 30-second cache of a good answer.
  const realNow = Date.now;
  spyOn(Date, "now").mockImplementation(() => realNow() + 31_000);
  await expect(client.getRuntimeEntitlements()).rejects.toMatchObject({
    status: 500,
  });
  expect(
    printed.mock.calls.some((call) =>
      call.includes("Runtime entitlement request failed"),
    ),
  ).toBe(true);
});
