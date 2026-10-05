import { describe, expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import type { AppVariables } from "../src/auth/guards";
import type { BotAccessCheck } from "../src/plugins/routes";
import { createPluginRoutes } from "../src/plugins/routes";
import type { PluginStore } from "../src/plugins/store";

function appWith(calls: { addServer: unknown[]; addCustomServer: unknown[] }) {
  const store = {
    addServer: async (input: unknown) => {
      // Mirror the real store: it dereferences `input.credentialId?.trim()`, so a
      // non-string credential id throws a TypeError that used to escape as a 500.
      const credentialId = (input as { credentialId?: unknown }).credentialId;
      if (credentialId !== undefined && typeof credentialId !== "string") {
        (credentialId as { trim: () => string }).trim();
      }
      calls.addServer.push(input);
      return { server: input };
    },
    addCustomServer: async (input: unknown) => {
      const credentialId = (input as { credentialId?: unknown }).credentialId;
      if (credentialId !== undefined && typeof credentialId !== "string") {
        (credentialId as { trim: () => string }).trim();
      }
      calls.addCustomServer.push(input);
      return { server: input };
    },
  } as unknown as PluginStore;
  const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
    context,
    next,
  ) => {
    context.set("actor", {
      id: "user-1",
      email: "user@openbot.test",
      role: "admin",
    });
    await next();
  };
  const canUseBot: BotAccessCheck = async () => true;
  return createPluginRoutes(store, requireUser, canUseBot);
}

function calls() {
  return { addServer: [] as unknown[], addCustomServer: [] as unknown[] };
}

/**
 * Optional fields reach `input.credentialId?.trim()` in the store, where a number throws a
 * TypeError that escapes the mapped-error catch and answers 500. A whitespace-only value would
 * silently coerce to `undefined` there. Both are refused at the edge with a 400 before the store
 * or audit trail is touched. `key` was truthiness-checked, so `123` passed the edge and only
 * failed later as an unknown catalogue entry.
 */
describe("POST /api/plugins/servers", () => {
  test.each([
    ["a number key", { key: 123 }],
    ["an object key", { key: {} }],
    ["a whitespace key", { key: "   " }],
    ["a number credentialId", { key: "user-oauth", credentialId: 123 }],
    ["an object credentialId", { key: "user-oauth", credentialId: {} }],
    ["an array credentialId", { key: "user-oauth", credentialId: [] }],
    ["a whitespace credentialId", { key: "user-oauth", credentialId: "   " }],
    ["a number instanceHost", { key: "k", instanceHost: 123 }],
    ["a whitespace instanceHost", { key: "k", instanceHost: "  " }],
  ])("refuses %s with 400 and never reaches the store", async (_n, body) => {
    const seen = calls();
    const response = await appWith(seen).request(
      "http://openbot.test/servers",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: expect.any(String),
    });
    expect(seen.addServer).toEqual([]);
    expect(seen.addCustomServer).toEqual([]);
  });

  test("trims the key and optional fields on the happy path", async () => {
    const seen = calls();
    const response = await appWith(seen).request(
      "http://openbot.test/servers",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          key: "  user-oauth  ",
          credentialId: "  cred-1  ",
        }),
      },
    );

    expect(response.status).toBe(200);
    expect(seen.addServer).toHaveLength(1);
    expect(seen.addServer[0]).toMatchObject({
      key: "user-oauth",
      credentialId: "cred-1",
    });
  });
});

/**
 * `POST /servers/custom` validated `id/title/url` but passed `credentialId` straight to
 * `addCustomServer`, where `input.credentialId?.trim()` throws on a number or object and the
 * route answers 500. Non-string ids also crashed `?.trim()` differently per field; all are 400
 * at the edge now.
 */
describe("POST /api/plugins/servers/custom", () => {
  test.each([
    [
      "a number credentialId",
      { id: "s", title: "T", url: "https://x.test", credentialId: 42 },
    ],
    [
      "an object credentialId",
      { id: "s", title: "T", url: "https://x.test", credentialId: {} },
    ],
    [
      "a whitespace credentialId",
      { id: "s", title: "T", url: "https://x.test", credentialId: "  " },
    ],
    ["a number id", { id: 123, title: "T", url: "https://x.test" }],
    ["a whitespace title", { id: "s", title: "   ", url: "https://x.test" }],
  ])("refuses %s with 400 and never reaches the store", async (_n, body) => {
    const seen = calls();
    const response = await appWith(seen).request(
      "http://openbot.test/servers/custom",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    );

    expect(response.status).toBe(400);
    expect(seen.addCustomServer).toEqual([]);
  });
});

/**
 * `POST /servers/:id/oauth-client` cast the body to `{ clientId?: string; clientSecret?: string }`
 * and then called `.trim()` on it. The body is JSON, so a number or an object passed the annotation
 * and threw a TypeError outside the try, and a person's malformed request answered 500. Every other
 * route in this file checks `typeof` first; this one is the same 400 now, before the store or the
 * audit trail is touched.
 */
describe("POST /api/plugins/servers/:id/oauth-client", () => {
  function oauthApp(registered: unknown[]) {
    const store = {
      registerOAuthClient: async (input: unknown) => {
        registered.push(input);
      },
    } as unknown as PluginStore;
    const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
      context,
      next,
    ) => {
      context.set("actor", {
        id: "user-1",
        email: "user@openbot.test",
        role: "admin",
      });
      await next();
    };
    const canUseBot: BotAccessCheck = async () => true;
    return createPluginRoutes(store, requireUser, canUseBot);
  }

  const send = (registered: unknown[], body: unknown) =>
    oauthApp(registered).request(
      "http://openbot.test/servers/github/oauth-client",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    );

  test.each([
    ["a number client id", { clientId: 12345, clientSecret: "secret" }],
    ["an object client id", { clientId: {}, clientSecret: "secret" }],
    ["a number client secret", { clientId: "id", clientSecret: 12345 }],
    ["an object client secret", { clientId: "id", clientSecret: {} }],
    ["an array client secret", { clientId: "id", clientSecret: [] }],
    ["a missing client secret", { clientId: "id" }],
    ["a whitespace client id", { clientId: "   ", clientSecret: "secret" }],
    ["a whitespace client secret", { clientId: "id", clientSecret: "  " }],
  ])("refuses %s with 400 and never reaches the store", async (_n, body) => {
    const registered: unknown[] = [];
    const response = await send(registered, body);

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "A client id and a client secret are both required.",
    });
    expect(registered).toEqual([]);
  });

  test("trims both values on the happy path", async () => {
    const registered: unknown[] = [];
    const response = await send(registered, {
      clientId: "  id  ",
      clientSecret: "  secret  ",
    });

    expect(response.status).toBe(200);
    expect(registered).toEqual([
      {
        serverId: "github",
        client: { clientId: "id", clientSecret: "secret" },
        by: "user@openbot.test",
      },
    ]);
  });
});
