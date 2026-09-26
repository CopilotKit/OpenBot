import { expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import type { AppVariables } from "../src/auth/guards";
import { createLearningRoutes } from "../src/learning/routes";
import { createLearningSettingsStore } from "../src/learning/settings";

function routes(role: "admin" | "user" = "admin") {
  const store = createLearningSettingsStore();
  const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
    context,
    next,
  ) => {
    context.set("actor", { id: "person", email: "person@example.com", role });
    await next();
  };
  return {
    store,
    app: createLearningRoutes(
      {
        store,
        inspect: async () => {
          throw new Error("secret-project-key");
        },
      },
      requireUser,
      ["https://openbot.example.com"],
    ),
  };
}

test("only administrators can read or write learning settings", async () => {
  const { app } = routes("user");
  expect((await app.request("/settings")).status).toBe(403);
  expect((await app.request("/settings", { method: "PUT" })).status).toBe(403);
});

test("rejects cross-origin and non-JSON writes before changing settings", async () => {
  const { app, store } = routes();
  for (const headers of [
    { "content-type": "application/json", origin: "https://evil.example" },
    { "content-type": "text/plain" },
  ]) {
    expect(
      (
        await app.request("https://openbot.example.com/settings", {
          method: "PUT",
          headers,
          body: JSON.stringify({
            enabled: true,
            defaultTarget: { containerId: "support" },
            agents: {},
          }),
        })
      ).status,
    ).toBe(403);
  }
  expect((await store.read()).enabled).toBe(false);
});

test("validates and persists a same-origin admin save", async () => {
  const { app } = routes();
  const settings = {
    enabled: true,
    defaultTarget: { containerId: "support" },
    agents: { excluded: null },
  };
  const response = await app.request("https://openbot.example.com/settings", {
    method: "PUT",
    headers: {
      "content-type": "application/json",
      origin: "https://openbot.example.com",
    },
    body: JSON.stringify(settings),
  });
  expect(response.status).toBe(200);
  expect(await (await app.request("/settings")).json()).toEqual({ settings });
  expect(
    (
      await app.request("/settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: '{"enabled":true}',
      })
    ).status,
  ).toBe(400);
});

test("upstream errors never expose credentials", async () => {
  const { app } = routes();
  const response = await app.request("/overview");
  expect(response.status).toBe(502);
  expect(await response.text()).not.toContain("secret-project-key");
});
