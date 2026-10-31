import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  callSignature,
  createRepeatMemory,
  REPEAT_LOOKBACK_MS,
  screenCall,
} from "../src/background/network/screen";
import { isPrefetch, isTelemetry } from "../src/background/network/telemetry";

test("the tab's own repeat of a call it made before is seen; the first one, and one in another tab, are not", () => {
  const gate = createRepeatMemory();
  const poll = callSignature("GET", "https://crm.example.test/api/unread", "");
  expect(gate.seen(1, poll, 1_000)).toBe(false);
  expect(gate.seen(1, poll, 31_000)).toBe(true);
  expect(gate.seen(2, poll, 31_000)).toBe(false);
  // The same call started earlier than the one already seen (a page event arriving late) is not its repeat.
  const late = callSignature("POST", "https://crm.example.test/api/x", "{}");
  expect(gate.seen(1, late, 50_000)).toBe(false);
  expect(gate.seen(1, late, 49_000)).toBe(false);
  // Ten minutes on, it is a call of its own again.
  expect(gate.seen(1, poll, 31_000 + REPEAT_LOOKBACK_MS + 1)).toBe(false);
});

test("a call's identity is its method, address without cache busters or fragment, and body", () => {
  const base = callSignature(
    "get",
    "https://crm.example.test/api/feed?page=2&_=1792431916496#top",
    undefined,
  );
  expect(
    callSignature(
      "GET",
      "https://crm.example.test/api/feed?page=2&_=1792431999999",
      "",
    ),
  ).toBe(base);
  expect(
    callSignature("GET", "https://crm.example.test/api/feed?page=3&_=1", ""),
  ).not.toBe(base);
  expect(
    callSignature("POST", "https://crm.example.test/api/graphql", '{"q":"a"}'),
  ).not.toBe(
    callSignature("POST", "https://crm.example.test/api/graphql", '{"q":"b"}'),
  );
});

test("telemetry, analytics, ads and monitoring are recognised by host and path; real API calls are not", () => {
  for (const url of [
    "https://www.google-analytics.com/g/collect?v=2",
    "https://region1.google-analytics.com/g/collect",
    "https://px.ads.linkedin.com/wa/",
    "https://eu.i.posthog.com/e/",
    "https://o123.ingest.us.sentry.io/api/45/envelope/",
    "https://browser-intake-datadoghq.com/api/v2/rum",
    "https://exceptions-eu1.crm.example.test/frontend/observability/page-tracking/store/",
    "https://metrics-fe-eu1.crm.example.test/open-telemetry-public/v1/public/sample-ratios",
    "https://crm.example.test/session-replay-config/v1/config",
    "https://crm.example.test/api/usage-logging/v1/log/multi/no-auth",
    "https://crm.example.test/api/nudge/tracking/v1/nudge-event",
    "https://crm.example.test/api/developer/platform/logging/public/publish/v1/system-logs/batch",
    "https://obs.example.test/mon",
    "https://www.facebook.com/tr/?id=1&ev=PageView",
    "https://capig.example.test/events/abc",
    "https://m.stripe.com/6",
    "https://collector.example.test/v1/traces",
    "https://shop.example.test/cdn-cgi/rum?",
    "https://shop.example.test/_vercel/insights/view",
  ])
    expect([url, isTelemetry(url)]).toEqual([url, true]);
  for (const url of [
    "https://crm.example.test/api/crm-record-cards/v4/container-views/get-view",
    "https://crm.example.test/api/crm/events/v3/timeline/0-1/9001",
    "https://crm.example.test/api/gateway/v1/com.example.assistant.rpc.AssistantService/sendMessage",
    "https://crm.example.test/api/graphql/crm",
    "https://shop.example.test/api/orders/42/tracking",
    "https://shop.example.test/api/payments/collect",
    "https://cloud.example.test/projects/p1/analytics",
    "https://cloud.example.test/logs",
    "https://api.example.test/v1/deals/42",
    "https://app.posthog.com/api/projects/1/insights",
  ])
    expect([url, isTelemetry(url)]).toEqual([url, false]);
  // An error report sent through the page's own tunnel route is known by its body.
  expect(
    isTelemetry(
      "https://cloud.example.test/monitoring",
      '{"event_id":"a","sent_at":"2026-10-19T00:00:00Z","dsn":"https://k@o1.ingest.sentry.io/2"}\n{"type":"event"}',
    ),
  ).toBe(true);
  expect(
    isTelemetry("https://cloud.example.test/monitoring", '{"query":"x"}'),
  ).toBe(false);
});

test("a prefetch is known by the headers the page or the browser puts on it", () => {
  expect(isPrefetch({ "next-router-prefetch": "1", rsc: "1" })).toBe(true);
  expect(isPrefetch({ "Sec-Purpose": "prefetch;prerender" })).toBe(true);
  expect(isPrefetch({ Purpose: "prefetch" })).toBe(true);
  expect(isPrefetch({ rsc: "1", "next-url": "/dashboard" })).toBe(false);
  expect(isPrefetch({})).toBe(false);
});

test("screening drops an aborted call, telemetry, a prefetch and a repeat before any body is read", () => {
  const call = {
    url: "https://crm.example.test/api/deals",
    method: "GET",
    outcome: "ok" as const,
    headers: {},
    repeat: false,
  };
  expect(screenCall(call)).toBeNull();
  expect(screenCall({ ...call, outcome: "error" })).toBeNull();
  expect(screenCall({ ...call, outcome: "aborted" })).toBe("aborted");
  expect(
    screenCall({ ...call, url: "https://www.google-analytics.com/g/collect" }),
  ).toBe("telemetry");
  expect(
    screenCall({ ...call, headers: { "next-router-prefetch": "1" } }),
  ).toBe("prefetch");
  expect(screenCall({ ...call, repeat: true })).toBe("repeat");
});

/** CopilotKit's own capture batches that end-to-end runs 1 and 2 attached to a click as its save. */
const LEARNING_BATCHES = (
  JSON.parse(
    readFileSync(
      join(import.meta.dir, "fixtures/e2e-learning-batches.json"),
      "utf8",
    ),
  ) as { batches: { url: string; body: string }[] }
).batches;

test("CopilotKit's own capture batch is the page reporting on itself, whatever route the page posts it to", () => {
  expect(LEARNING_BATCHES).toHaveLength(3);
  for (const { url, body } of LEARNING_BATCHES) {
    expect(isTelemetry(url, body)).toBe(true);
    expect(isTelemetry("https://crm.example.test/api/v2/sync", body)).toBe(
      true,
    );
    expect(
      screenCall({
        url,
        method: "POST",
        outcome: "ok",
        headers: { "content-type": "application/json" },
        body,
        repeat: false,
      }),
    ).toBe("telemetry");
    // Cut short, it is still known by how CopilotKit's httpSink writes it.
    expect(isTelemetry(url, body.slice(0, 120))).toBe(true);
  }
  // A batch with no events reports only what was lost; a batch scoped to learning containers names them.
  expect(
    isTelemetry(
      "https://crm.example.test/api/learning-events",
      '{"trajectoryId":"t-1","learningContainerIds":["c-1"],"events":[],"dropped":4}',
    ),
  ).toBe(true);
  // A save that names a trajectory, or keeps events of its own, is no capture batch.
  for (const body of [
    '{"trajectoryId":"t-1","title":"Q3 review"}',
    '{"events":[{"type":"CUSTOM","name":"x","timestamp":1,"value":{}}],"dropped":0}',
    '{"trajectoryId":"t-1","events":[{"name":"Kickoff","date":"2026-10-21"}],"dropped":0}',
    '{"trajectoryId":"t-1","events":[],"dropped":0,"owner":"ana"}',
    '{"trajectoryId":"t-1","events":[{"name":"Kickoff","date":"2026-10-21"}',
  ])
    expect(isTelemetry("https://crm.example.test/api/trajectories", body)).toBe(
      false,
    );
});

test("CopilotKit's own capture asking its runtime for a capture pass is the page reporting on itself, never a save", () => {
  // The two requests @copilotkit/core's TrajectoryConnection sends (CopilotKit main c21eeda029): the REST route with an
  // empty body, and the single route's envelope.
  const trajectoryId = "6b0e2f1c-9d3a-4c5e-8f7a-1b2c3d4e5f60";
  const rest = {
    url: `https://crm.example.test/api/copilotkit/trajectory/${encodeURIComponent(trajectoryId)}/connect`,
    body: JSON.stringify({}),
  };
  const single = {
    url: "https://crm.example.test/api/copilotkit",
    body: JSON.stringify({
      method: "trajectory/connect",
      params: { trajectoryId },
      body: {},
    }),
  };
  for (const { url, body } of [rest, single]) {
    expect(isTelemetry(url, body)).toBe(true);
    expect(
      screenCall({
        url,
        method: "POST",
        outcome: "ok",
        headers: { "content-type": "application/json" },
        body,
        repeat: false,
      }),
    ).toBe("telemetry");
  }
  // The same runtime's agent run, and an app's own route that mentions trajectories, are not.
  expect(
    isTelemetry(
      "https://crm.example.test/api/copilotkit",
      JSON.stringify({
        method: "agent/run",
        params: { agentId: "default" },
        body: { threadId: "t-1", runId: "r-1", messages: [] },
      }),
    ),
  ).toBe(false);
  expect(
    isTelemetry(
      "https://crm.example.test/api/trajectory/review",
      '{"note":"connect the trajectory/connect dots"}',
    ),
  ).toBe(false);
});
