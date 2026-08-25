import { describe, expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { AppVariables } from "../src/auth/guards";
import { createPluginRoutes } from "../src/plugins/routes";
import type { OAuthClient } from "../src/plugins/store";

/**
 * `POST /servers/:id/connect`, for a dynamically registered vendor.
 *
 * Notion has no administrator step: nobody pastes a client id, so the first person to connect is
 * the one who makes the deployment introduce itself (RFC 7591) to the vendor. Google Drive is the
 * regression pin for the OLD behaviour, which must survive unchanged for a manually registered
 * vendor: no stored client is still a 409 telling an administrator to add one, and registration is
 * never attempted for it.
 */

const ENCRYPTION_KEY = "a".repeat(32);

function signedIn(): MiddlewareHandler<{ Variables: AppVariables }> {
  return async (context, next) => {
    context.set("actor", {
      id: "user-1",
      email: "person@openbot.test",
      role: "user",
    } as never);
    await next();
  };
}

function app(store: {
  oauthClientFor: (serverId: string) => Promise<OAuthClient | null>;
  ensureOAuthClient: (
    serverId: string,
    by: string,
  ) => Promise<OAuthClient | null>;
}) {
  const routes = createPluginRoutes(
    store as never,
    signedIn(),
    async () => true,
    {
      publicUrl: "https://openbot.example",
      appUrl: "https://app.example",
      encryptionKey: ENCRYPTION_KEY,
    },
  );
  return new Hono().route("/api/plugins", routes);
}

describe("connecting a dynamically registered vendor", () => {
  test("registers a client on first connect and mints an authorization URL with it", async () => {
    const ensureCalls: { serverId: string; by: string }[] = [];
    const hono = app({
      oauthClientFor: async () => null,
      ensureOAuthClient: async (serverId, by) => {
        ensureCalls.push({ serverId, by });
        return { clientId: "dyn-1", clientSecret: "" };
      },
    });

    const response = await hono.request(
      "http://t/api/plugins/servers/notion/connect",
      { method: "POST" },
    );

    expect(response.status).toBe(200);
    expect(ensureCalls).toEqual([
      { serverId: "notion", by: "person@openbot.test" },
    ]);

    const body = (await response.json()) as { authorizationUrl: string };
    const url = new URL(body.authorizationUrl);
    expect(url.host).toBe("mcp.notion.com");
    expect(url.pathname).toBe("/authorize");
    expect(url.searchParams.get("client_id")).toBe("dyn-1");
  });

  test("a refused registration answers 502, naming the vendor", async () => {
    const ensureCalls: { serverId: string; by: string }[] = [];
    const hono = app({
      oauthClientFor: async () => null,
      ensureOAuthClient: async (serverId, by) => {
        ensureCalls.push({ serverId, by });
        return null;
      },
    });

    const response = await hono.request(
      "http://t/api/plugins/servers/notion/connect",
      { method: "POST" },
    );

    expect(response.status).toBe(502);
    expect(ensureCalls.length).toBe(1);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe(
      "Notion refused this deployment's registration. Try again, and check the vendor's status if it persists.",
    );
  });
});

describe("connecting a manually registered vendor (regression pin)", () => {
  test("still 409s with no client registered, and never attempts self-registration", async () => {
    const ensureCalls: { serverId: string; by: string }[] = [];
    const hono = app({
      oauthClientFor: async () => null,
      ensureOAuthClient: async (serverId, by) => {
        ensureCalls.push({ serverId, by });
        return { clientId: "should-not-happen", clientSecret: "x" };
      },
    });

    const response = await hono.request(
      "http://t/api/plugins/servers/google-drive/connect",
      { method: "POST" },
    );

    expect(response.status).toBe(409);
    expect(ensureCalls).toEqual([]);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("no OAuth client registered");
  });
});
