import { expect, test } from "bun:test";
import { Hono, type MiddlewareHandler } from "hono";
import { productStoreFixture } from "../scripts/support/product-store";
import { observedProductRun } from "../scripts/support/product-run";
import type { AppVariables } from "../src/auth/guards";
import { createProductTelemetry } from "../src/telemetry/product";
import { createProductTelemetryRoutes } from "../src/telemetry/product-routes";

async function fixture() {
  const f = productStoreFixture();
  const telemetry = await createProductTelemetry({
    store: f.store,
    env: { OPENBOT_PRODUCT_TELEMETRY: "1" },
    send: async () => {},
  });
  await observedProductRun(telemetry);
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
  return { ...f, telemetry, app, request };
}
const event = {
  kind: "result_viewed",
  threadId: "thread-one",
  messageId: "message-run-one",
  surface: "web",
};
test("authenticated result actions dedupe on trusted actor, thread, message and owning run", async () => {
  const f = await fixture();
  expect((await f.request(event)).status).toBe(204);
  expect((await f.request(event)).status).toBe(204);
  expect(
    [...f.events.values()].filter((e) => e.name.endsWith("result_viewed")),
  ).toHaveLength(1);
  expect((await f.request(event, "other-user")).status).toBe(202);
  expect((await f.request({ ...event, runId: "forged" })).status).toBe(404);
});
test("endpoint rejects unauthenticated, raw/extra fields and oversized payloads", async () => {
  const f = await fixture();
  expect((await f.request(event, "")).status).toBe(401);
  expect((await f.request({ ...event, userId: "forged" })).status).toBe(400);
  expect(
    (await f.request({ ...event, messageId: "x".repeat(5000) })).status,
  ).toBe(413);
});
test("unknown historical linkage stays pending and health is administrator scoped", async () => {
  const f = await fixture();
  expect((await f.request({ ...event, messageId: "historical" })).status).toBe(
    202,
  );
  expect(
    (
      await f.app.request("/api/telemetry/health", {
        headers: { "x-test-actor": "private-user-one" },
      })
    ).status,
  ).toBe(403);
  const response = await f.app.request("/api/telemetry/health", {
    headers: { "x-test-actor": "admin" },
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    transportAcknowledgesDelivery: false,
  });
});
