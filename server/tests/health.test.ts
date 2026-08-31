import { describe, expect, test } from "bun:test";
import { createApp } from "../src/app";
import { loadConfig } from "../src/config";
import { testEnvironment } from "./support/environment";

const app = createApp(
  loadConfig({
    ...testEnvironment(),
  }),
);

describe("health endpoint", () => {
  test("reports the server as healthy", async () => {
    const response = await app.request("http://openbot.local/health");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: "ok" });
  });
});

describe("runtime capabilities", () => {
  test("reports the Intelligence runtime without exposing configuration secrets", async () => {
    const response = await app.request("http://openbot.local/api/capabilities");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      mode: "intelligence",
      durableHistory: true,
      // Off until a deployment asks for it. The browser reads this to decide whether to offer the
      // tool that generates an interface, so it has to be here and not only in the runtime.
      generativeUi: false,
      // Names only. The sign-in screen reads this to know which buttons to draw.
      authProviders: ["google"],
      // A boolean, not a list: naming the registered providers would tell anybody who loads the
      // sign-in page which companies use this deployment.
      ssoConfigured: false,
    });
  });

  // The runtime object holds the Intelligence API key and licence token. This endpoint has no
  // authentication, so a projection bug here publishes deployment secrets to anyone who asks.
  test("never serves the Intelligence credentials", async () => {
    const response = await app.request("http://openbot.local/api/capabilities");
    const body = await response.text();
    const parsed = (await new Response(body).json()) as Record<string, unknown>;

    expect(body).not.toContain("tenant-api-key");
    expect(body).not.toContain("license-token");
    // The settings object itself must not be projected, whatever it happens to hold today.
    expect(Object.keys(parsed)).toEqual([
      "mode",
      "durableHistory",
      "generativeUi",
      "authProviders",
      "ssoConfigured",
    ]);
    // The provider list is names, never the clients and secrets behind them.
    expect(body).not.toContain("google-client-secret");
  });

  /*
   * The answer has to reach the browser, not just the runtime.
   *
   * The app offers the model the tool that generates an interface, and it decides whether to from
   * this field. The two halves disagreeing is the one configuration this capability must not be able
   * to end up in: runtime-only means the tool is never offered, browser-only means a Bot writes a
   * whole interface that nothing renders.
   */
  test("reports generated interfaces as on when the deployment asked for them", async () => {
    const enabled = createApp(
      loadConfig(testEnvironment({ OPENBOT_GENERATIVE_UI: "true" })),
    );

    const response = await enabled.request(
      "http://openbot.local/api/capabilities",
    );

    expect(response.status).toBe(200);
    expect((await response.json()).generativeUi).toBe(true);
  });
});

describe("authentication availability", () => {
  test("fails loudly when no identity provider has been configured", async () => {
    const response = await app.request(
      "http://openbot.local/api/auth/sign-in/social",
      { method: "POST" },
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "No identity provider is configured.",
    });
  });

  test("forwards auth requests to the configured Better Auth handler", async () => {
    const authenticatedApp = createApp(
      loadConfig({
        ...testEnvironment(),
      }),
      {
        handler: () => new Response("mounted", { status: 204 }),
      },
    );

    const response = await authenticatedApp.request(
      "http://openbot.local/api/auth/callback/google",
    );

    expect(response.status).toBe(204);
  });

  test("forwards logout requests to Better Auth", async () => {
    const authenticatedApp = createApp(
      loadConfig({
        ...testEnvironment(),
      }),
      {
        handler: () => new Response(null, { status: 204 }),
        api: {
          getSession: async () => null,
        },
      },
    );

    const response = await authenticatedApp.request(
      "http://openbot.local/api/auth/sign-out",
      { method: "POST" },
    );

    expect(response.status).toBe(204);
  });
});

/**
 * Who may register an identity provider.
 *
 * Better Auth's SSO plugin guards these with a session, which asks only that somebody is signed in.
 * That is the wrong bar: registering an IdP for a domain means anybody it vouches for can sign in,
 * so a plain user reaching it could mint themselves colleagues. These pin the gate in front of it.
 */
describe("identity provider registration", () => {
  function appFor(roles: ("admin" | "user")[], signedIn = true) {
    let reachedHandler = false;
    const app = createApp(
      loadConfig(testEnvironment()),
      {
        handler: () => {
          reachedHandler = true;
          return new Response(null, { status: 200 });
        },
        api: {
          getSession: async () =>
            signedIn ? { user: { id: "u1", email: "u1@openbot.test" } } : null,
        },
      } as never,
      { rolesForUser: async () => roles },
    );
    return { app, reached: () => reachedHandler };
  }

  const routes = [
    "/api/auth/sso/register",
    "/api/auth/sso/update-provider",
    "/api/auth/sso/delete-provider",
  ];

  test.each(routes)("refuses %s to a plain user", async (route) => {
    const { app, reached } = appFor(["user"]);

    const response = await app.request(`http://openbot.test${route}`, {
      method: "POST",
    });

    expect(response.status).toBe(403);
    // Refused in front of Better Auth, not by it: the plugin would have allowed this.
    expect(reached()).toBe(false);
  });

  test.each(routes)("refuses %s to somebody signed out", async (route) => {
    const { app, reached } = appFor([], false);

    const response = await app.request(`http://openbot.test${route}`, {
      method: "POST",
    });

    expect(response.status).toBe(403);
    expect(reached()).toBe(false);
  });

  test.each(routes)("lets an administrator through to %s", async (route) => {
    const { app, reached } = appFor(["admin"]);

    await app.request(`http://openbot.test${route}`, { method: "POST" });

    expect(reached()).toBe(true);
  });

  // Everything else under /api/auth is Better Auth's own business, including sign-in itself, which
  // by definition happens before anybody has a role.
  test("leaves the rest of the auth routes alone", async () => {
    const { app, reached } = appFor([], false);

    await app.request("http://openbot.test/api/auth/sign-in/social", {
      method: "POST",
    });

    expect(reached()).toBe(true);
  });
});
