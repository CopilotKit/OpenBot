import { describe, expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { AppVariables } from "../src/auth/guards";
import type { BotAccessCheck } from "../src/plugins/routes";
import { createPluginRoutes } from "../src/plugins/routes";
import type { PluginStore } from "../src/plugins/store";

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

/**
 * `args` used to flow into `Object.entries` inside the store, where a string fans out into
 * indexed entries, a number yields none, and an array passes as an object — surfacing as a
 * vendor 502 instead of a malformed-call 400. Only a plain JSON object is admissible now.
 */
describe("POST /api/plugins/call args", () => {
  function appWith(calls: unknown[]) {
    const store = {
      callTool: async (input: unknown) => {
        calls.push(input);
        return { ok: true };
      },
    } as unknown as PluginStore;
    return createPluginRoutes(store, requireUser, canUseBot);
  }

  test.each([
    ["a string", "oops"],
    ["a number", 42],
    ["an array", [1, 2]],
    ["null", null],
  ])("refuses %s with 400 and never reaches the store", async (_n, args) => {
    const calls: unknown[] = [];
    const body = { ref: "s/t", agentId: "bot-1", args };
    const response = await appWith(calls).request("http://openbot.test/call", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "Tool arguments must be an object.",
    });
    expect(calls).toEqual([]);
  });

  test("accepts a plain object and omits args when absent", async () => {
    const calls: unknown[] = [];
    const app = appWith(calls);
    for (const body of [
      { ref: "s/t", agentId: "bot-1", args: { q: "hi" } },
      { ref: "s/t", agentId: "bot-1" },
    ]) {
      const response = await app.request("http://openbot.test/call", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(200);
    }
    expect(calls).toHaveLength(2);
  });
});

describe("POST /api/components/:name/call args", () => {
  test("refuses non-object args with 400 before any grant check", async () => {
    // Import the route module lazily so this test stays decoupled from the component store.
    const { createComponentRoutes } = await import("../src/components/routes");
    const store = {
      decide: async () => {
        throw new Error("must not reach the store");
      },
      mayCall: async () => true,
      callFunction: async () => ({}),
    };
    const app = new Hono<{ Variables: AppVariables }>();
    app.use(requireUser);
    app.route(
      "/",
      createComponentRoutes(
        store as never,
        requireUser,
        undefined,
        async () => true,
      ),
    );

    for (const args of ["oops", 42, [1]]) {
      const response = await app.request("http://openbot.test/widget/call", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ function: "f", agentId: "bot-1", args }),
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: "Function arguments must be an object.",
      });
    }
  });
});
