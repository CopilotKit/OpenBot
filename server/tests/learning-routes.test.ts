import { expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import type { AppVariables } from "../src/auth/guards";
import {
  createLearningAutoAssign,
  withLearningAutoAssign,
} from "../src/learning/auto-assign";
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

test("administrators see learning enabled before selecting a container", async () => {
  const { app } = routes();
  const response = await app.request("/settings");
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    settings: { enabled: true, defaultTarget: null, agents: {} },
  });
});

test("rejects cross-origin and non-JSON writes before changing settings", async () => {
  const { app, store } = routes();
  const before = await store.read();
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
  expect(await store.read()).toEqual(before);
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

test("the settings page assigns a newly created container on load and says why not otherwise", async () => {
  const store = createLearningSettingsStore();
  let probe: "absent" | "present" = "absent";
  const autoAssign = createLearningAutoAssign({
    enabled: true,
    store,
    probe: async () => probe,
    log: () => {},
    minIntervalMs: 0,
  });
  const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
    context,
    next,
  ) => {
    context.set("actor", {
      id: "person",
      email: "person@example.com",
      role: "admin",
    });
    await next();
  };
  const app = createLearningRoutes(
    { store: withLearningAutoAssign(store, autoAssign), autoAssign },
    requireUser,
  );
  expect(await (await app.request("/settings")).json()).toEqual({
    settings: { enabled: true, defaultTarget: null, agents: {} },
    automatic: {
      state: "absent",
      containerId: "openbot",
      canCreate: false,
      instructions: expect.stringContaining("bun scripts/setup-learning.ts"),
    },
  });
  probe = "present";
  expect(await (await app.request("/settings")).json()).toEqual({
    settings: {
      enabled: true,
      defaultTarget: { containerId: "openbot" },
      agents: {},
    },
    automatic: { state: "assigned", containerId: "openbot" },
  });
});

test("an administrator creates the container with the deployment's credential, same-origin only", async () => {
  const store = createLearningSettingsStore();
  let probe: "absent" | "present" = "absent";
  let creates = 0;
  const autoAssign = createLearningAutoAssign({
    enabled: true,
    store,
    probe: async () => probe,
    // As at boot: the first attempt finds nothing to create with yet.
    create: async () => {
      creates++;
      if (creates === 1) return "skipped";
      probe = "present";
      return "created";
    },
    log: () => {},
  });
  await autoAssign.check();
  const actor = (role: "admin" | "user") =>
    (async (context, next) => {
      context.set("actor", {
        id: "person",
        email: "person@example.com",
        role,
      });
      await next();
    }) as MiddlewareHandler<{ Variables: AppVariables }>;
  const post = (app: ReturnType<typeof createLearningRoutes>, origin: string) =>
    app.request("https://openbot.example.com/container", {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: "{}",
    });
  const member = createLearningRoutes({ store, autoAssign }, actor("user"));
  expect((await post(member, "https://openbot.example.com")).status).toBe(403);
  const admin = createLearningRoutes({ store, autoAssign }, actor("admin"));
  expect((await post(admin, "https://evil.example")).status).toBe(403);
  expect(creates).toBe(1);
  const response = await post(admin, "https://openbot.example.com");
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    automatic: { state: "assigned", containerId: "openbot" },
  });
  expect(creates).toBe(2);
  expect((await store.read()).defaultTarget).toEqual({
    containerId: "openbot",
  });
});
