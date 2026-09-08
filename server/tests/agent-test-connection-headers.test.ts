import { describe, expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import type { AppVariables } from "../src/auth/guards";
import {
  createAgentRoutes,
  parseConnectionHeaders,
} from "../src/agents/routes";

describe("parseConnectionHeaders", () => {
  test("absent headers stay absent", () => {
    expect(parseConnectionHeaders(undefined)).toEqual({
      ok: true,
      value: undefined,
    });
  });

  test("a valid map passes through", () => {
    expect(parseConnectionHeaders({ Authorization: "Bearer x" })).toEqual({
      ok: true,
      value: { Authorization: "Bearer x" },
    });
  });

  test.each([
    ["an array", ["Authorization"]],
    ["a string", "Authorization: Bearer x"],
    ["a number", 42],
    ["an array value", { Authorization: ["Bearer x"] }],
    ["a numeric value", { Authorization: 42 }],
    ["a nested value", { Authorization: { token: "x" } }],
    ["a null value", { Authorization: null }],
    // An object literal cannot carry its own __proto__: the syntax sets the prototype instead, so
    // the value travels through JSON text the way a real request body does.
    ["a __proto__ key", JSON.parse('{"__proto__":"polluted"}')],
    ["a constructor key", { constructor: "x" }],
    ["an invalid name", { "X Bad Name!": "x" }],
    ["an empty name", { "": "x" }],
  ])("rejects %s", (_name, input) => {
    const parsed = parseConnectionHeaders(input);
    expect(parsed.ok).toBe(false);
  });
});

describe("POST /test-connection header validation", () => {
  function appFor() {
    const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
      context,
      next,
    ) => {
      context.set("actor", {
        id: "user-1",
        email: "user@openbot.test",
        role: "user",
      });
      await next();
    };
    return createAgentRoutes({} as never, requireUser, true);
  }

  test("invalid headers answer 400 without probing", async () => {
    const app = appFor();
    const response = await app.request("http://openbot.test/test-connection", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        endpoint: "https://agent.example/ag-ui",
        headers: { Authorization: ["Bearer x"] },
      }),
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toMatch(/must be a string value/);
  });

  test("a __proto__ key answers 400", async () => {
    const app = appFor();
    // Built as text: an object literal cannot carry its own __proto__ through JSON.stringify, so
    // a real request carrying one arrives as raw JSON exactly like this.
    const rawBody = JSON.stringify({
      endpoint: "https://agent.example/ag-ui",
    }).replace(/}$/, ',"headers":{"__proto__":"polluted"}}');
    const response = await app.request("http://openbot.test/test-connection", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: rawBody,
    });

    expect(response.status).toBe(400);
  });
});
