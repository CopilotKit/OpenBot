import { expect, test } from "bun:test";
import type { LambdaSendOptions } from "@copilotkit/shared";
import { Hono, type MiddlewareHandler } from "hono";

import type { AppVariables } from "../src/auth/guards";
import { createProductTelemetry } from "../src/telemetry/product";
import { createProductTelemetryRoutes } from "../src/telemetry/product-routes";

async function fixture() {
  const sent: LambdaSendOptions[] = [];
  const telemetry = await createProductTelemetry({
    privacyKey: "synthetic-key",
    deploymentId: "deployment",
    env: { OPENBOT_PRODUCT_TELEMETRY: "1" },
    send: async (event) => {
      sent.push(event);
    },
  });

  const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
    c,
    next,
  ) => {
    const id = c.req.header("x-test-actor");
    if (!id) return c.json({ error: "Sign in" }, 401);
    c.set("actor", {
      id,
      email: "synthetic@example.test",
      role: id === "admin" ? "admin" : "user",
    });
    await next();
  };
  const app = new Hono().route(
    "/api/telemetry",
    createProductTelemetryRoutes(requireUser, telemetry),
  );
  const request = (body: unknown, actor = "private-user-one") =>
    app.request("/api/telemetry/product-events", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(actor ? { "x-test-actor": actor } : {}),
      },
      body: JSON.stringify(body),
    });
  return { sent, telemetry, app, request };
}
const event = {
  kind: "result_viewed",
  threadId: "thread-one",
  messageId: "message-run-one",
  surface: "web",
};
test("authenticated telemetry uses server actor and stable analytics IDs without database linkage", async () => {
  const f = await fixture();
  expect((await f.request(event)).status).toBe(204);
  expect((await f.request(event)).status).toBe(204);
  expect(f.sent).toHaveLength(2);
  expect(f.sent[0]?.properties?.event_id).toBe(f.sent[1]?.properties?.event_id);
  expect((await f.request(event, "other-user")).status).toBe(204);
  expect(f.sent[0]?.properties?.user_id).not.toBe(
    f.sent[2]?.properties?.user_id,
  );
  expect(f.sent[0]?.properties).toMatchObject({
    event_id: expect.any(String),
  });
  expect(f.sent[0]?.properties).not.toHaveProperty("outcome");
});
test("endpoint rejects unauthenticated, raw/extra fields and oversized payloads", async () => {
  const f = await fixture();
  expect((await f.request(event, "")).status).toBe(401);
  expect((await f.request({ ...event, userId: "forged" })).status).toBe(400);
  expect(
    (await f.request({ ...event, messageId: "x".repeat(5000) })).status,
  ).toBe(413);
});
test("bounded historical references are forwarded without fabricated success and no health endpoint", async () => {
  const f = await fixture();
  expect((await f.request({ ...event, messageId: "historical" })).status).toBe(
    204,
  );
  expect((await f.request({ ...event, outcome: "success" })).status).toBe(400);
  expect(
    (
      await f.app.request("/api/telemetry/health", {
        headers: { "x-test-actor": "admin" },
      })
    ).status,
  ).toBe(404);
});
