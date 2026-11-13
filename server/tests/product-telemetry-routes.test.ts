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

/*
 * The ask to star OpenBot on GitHub, counted per trigger so the triggers can be compared. A person,
 * not a click: the same answer twice is one event id, and nothing names a thread or a message.
 */
const star = {
  kind: "star_prompt_clicked",
  trigger: "prompts",
  surface: "desktop",
};
test("a star prompt event is forwarded under the person's pseudonym, with its trigger and surface", async () => {
  const f = await fixture();
  expect((await f.request(star)).status).toBe(204);
  expect(f.sent).toHaveLength(1);
  expect(f.sent[0]?.event).toBe("oss.runtime.openbot.star_prompt_clicked");
  // Named for the prompt: run events already use `trigger` and `surface` for something else.
  expect(f.sent[0]?.properties).toMatchObject({
    prompt_trigger: "prompts",
    prompt_surface: "desktop",
    user_id: expect.stringMatching(/^ob_/),
  });
  expect(f.sent[0]?.properties).not.toHaveProperty("trigger");
  expect(f.sent[0]?.properties).not.toHaveProperty("surface");
  expect(String(f.sent[0]?.properties?.user_id)).not.toContain(
    "private-user-one",
  );
  expect(f.sent[0]?.properties).not.toHaveProperty("thread_id");
  expect(f.sent[0]?.properties).not.toHaveProperty("message_id");
});
test("the same person and answer is one event id, and another trigger is another", async () => {
  const f = await fixture();
  await f.request(star);
  await f.request(star);
  await f.request({ ...star, trigger: "settings" });
  for (const kind of ["star_prompt_shown", "star_prompt_dismissed"]) {
    expect((await f.request({ ...star, kind })).status).toBe(204);
  }
  expect(f.sent[0]?.properties?.event_id).toBe(f.sent[1]?.properties?.event_id);
  expect(f.sent[2]?.properties?.event_id).not.toBe(
    f.sent[0]?.properties?.event_id,
  );
  expect(f.sent.map((sent) => sent.event)).toEqual([
    "oss.runtime.openbot.star_prompt_clicked",
    "oss.runtime.openbot.star_prompt_clicked",
    "oss.runtime.openbot.star_prompt_clicked",
    "oss.runtime.openbot.star_prompt_shown",
    "oss.runtime.openbot.star_prompt_dismissed",
  ]);
});
test("a star prompt event refuses an unknown trigger, surface or kind, and any extra field", async () => {
  const f = await fixture();
  for (const body of [
    { ...star, trigger: "onboarding" },
    { ...star, surface: "mobile" },
    { ...star, kind: "star_prompt_starred" },
    { ...star, threadId: "thread-one" },
    { kind: "star_prompt_clicked", trigger: "prompts" },
  ]) {
    expect((await f.request(body)).status).toBe(400);
  }
  expect(f.sent).toHaveLength(0);
});
test("with product telemetry off, a star prompt event is accepted and nothing is sent", async () => {
  const sent: LambdaSendOptions[] = [];
  const telemetry = await createProductTelemetry({
    privacyKey: "synthetic-key",
    deploymentId: "deployment",
    env: {},
    send: async (event) => {
      sent.push(event);
    },
  });
  const app = new Hono().route(
    "/api/telemetry",
    createProductTelemetryRoutes(async (c, next) => {
      c.set("actor", {
        id: "private-user-one",
        email: "synthetic@example.test",
        role: "user",
      });
      await next();
    }, telemetry),
  );
  const response = await app.request("/api/telemetry/product-events", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(star),
  });
  expect(response.status).toBe(204);
  expect(sent).toHaveLength(0);
});
