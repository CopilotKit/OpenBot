import { describe, expect, test } from "bun:test";
import { createApp } from "../src/app";
import { loadConfig } from "../src/config";
import { testEnvironment } from "./support/environment";

const config = loadConfig({
  ...testEnvironment(),
});

const noSessionAuth = {
  handler: () => new Response(null, { status: 204 }),
  api: {
    getSession: async () => null,
  },
};

function authenticatedAs(
  userId: string,
  email = "member@openbot.test",
  name = "OpenBot Member",
  image = "https://example.test/member.png",
) {
  return {
    handler: () => new Response(null, { status: 204 }),
    api: {
      getSession: async () => ({ user: { id: userId, email, name, image } }),
    },
  };
}

describe("server authorization", () => {
  test("returns 401 when a protected route has no session", async () => {
    const app = createApp(config, noSessionAuth, {
      rolesForUser: async () => [],
    });

    const response = await app.request("http://openbot.local/api/me");

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: "Authentication required.",
    });
  });

  test("denies a signed-in user from an administrator route", async () => {
    const app = createApp(config, authenticatedAs("member"), {
      rolesForUser: async () => ["user"],
    });

    const response = await app.request("http://openbot.local/api/admin/status");

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "Administrator access required.",
    });
  });

  test("returns the authenticated user actor", async () => {
    const app = createApp(config, authenticatedAs("member"), {
      rolesForUser: async () => ["user"],
    });

    const response = await app.request("http://openbot.local/api/me");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      user: {
        id: "member",
        email: "member@openbot.test",
        name: "OpenBot Member",
        image: "https://example.test/member.png",
        hasCustomAvatar: false,
        role: "user",
        // No store was passed, so this deployment tracks no onboarding and the app gates nobody.
        onboarding: null,
      },
    });
  });

  test("allows an administrator to reach an administrator route", async () => {
    const app = createApp(config, authenticatedAs("admin"), {
      rolesForUser: async () => ["admin"],
    });

    const response = await app.request("http://openbot.local/api/admin/status");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: "ok" });
  });
});
