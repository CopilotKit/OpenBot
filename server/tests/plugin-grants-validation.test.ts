import { describe, expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import type { AppVariables } from "../src/auth/guards";
import type { BotAccessCheck } from "../src/plugins/routes";
import { createPluginRoutes } from "../src/plugins/routes";
import type { PluginStore } from "../src/plugins/store";

function appWith(
  calls: {
    grants: unknown[];
    toolCalls: unknown[];
    revokes?: unknown[];
    serverLookups?: unknown[];
  },
  /** The apps this deployment has added, for the grant path's existence check. */
  servers: string[] = ["tool"],
) {
  const store = {
    serverExists: async (serverId: string) => {
      calls.serverLookups?.push(serverId);
      return servers.includes(serverId);
    },
    grant: async (kind: unknown, ref: unknown, agentId: unknown) => {
      calls.grants.push({ kind, ref, agentId });
      return { ok: true };
    },
    revoke: async (kind: unknown, ref: unknown, agentId: unknown) => {
      calls.revokes?.push({ kind, ref, agentId });
    },
    callTool: async (input: unknown) => {
      calls.toolCalls.push(input);
      return { ok: true };
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

/**
 * The body is JSON, so the annotation is a wish.
 *
 * `{"ref":123,"agentId":[]}` is truthy and used to pass the presence check, then reach the store
 * where Drizzle compares a text column against a number and the request answers 500. A ref and a
 * Bot id are non-empty strings; anything else is a 400 before any grant, call, or audit row.
 */
describe("POST /api/plugins/grants", () => {
  test.each([
    ["a number ref", { kind: "mcp", ref: 123, agentId: "bot-1" }],
    ["an object ref", { kind: "mcp", ref: {}, agentId: "bot-1" }],
    ["a number agentId", { kind: "mcp", ref: "tool", agentId: 456 }],
    ["an array agentId", { kind: "mcp", ref: "tool", agentId: [] }],
    ["a whitespace ref", { kind: "mcp", ref: "   ", agentId: "bot-1" }],
    ["a whitespace agentId", { kind: "mcp", ref: "tool", agentId: "  " }],
  ])("refuses %s with 400 and never reaches the store", async (_n, body) => {
    const calls = { grants: [] as unknown[], toolCalls: [] as unknown[] };
    const response = await appWith(calls).request(
      "http://openbot.test/grants",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "A kind, a ref and a Bot are required.",
    });
    expect(calls.grants).toEqual([]);
  });
});

/**
 * A GRANT NAMING NO APP IS A GRANT THAT COULD NEVER DO ANYTHING.
 *
 * `store.grant` is a bare upsert and the mcp branch of `enablementRefusal` checked only the role, so
 * a ref naming an app this deployment had not added was stored and then invisible — the surface that
 * reports a grant nothing advertises is built per server row, and there was no row. #572 closed the
 * way these rows were MADE, by taking an app's grants when the app is removed, and its migration
 * deleted the ones already there. This is the other door into the same room: add the app afterwards
 * and the id is the same, the action names are the same, and every such grant resolves, with nobody
 * having granted anything and no row in the trail saying so.
 */
describe("POST /api/plugins/grants, for an app this deployment does not have", () => {
  test("refuses the grant and never reaches the store", async () => {
    const calls = {
      grants: [] as unknown[],
      toolCalls: [] as unknown[],
      serverLookups: [] as unknown[],
    };
    const response = await appWith(calls, ["added-app"]).request(
      "http://openbot.test/grants",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "mcp",
          ref: "missing-app/SEND_MESSAGE",
          agentId: "bot-1",
        }),
      },
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error:
        "missing-app is not an app this deployment has added, so there is nothing for a Bot to reach. Add it first, and its tools can be granted then.",
    });
    expect(calls.grants).toEqual([]);
    // The server half, not the whole ref: the tool is not what is being looked up.
    expect(calls.serverLookups).toEqual(["missing-app"]);
  });

  test("an app that is here is granted as before", async () => {
    const calls = {
      grants: [] as unknown[],
      toolCalls: [] as unknown[],
      serverLookups: [] as unknown[],
    };
    const response = await appWith(calls, ["added-app"]).request(
      "http://openbot.test/grants",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "mcp",
          ref: "added-app/SEND_MESSAGE",
          agentId: "bot-1",
        }),
      },
    );

    expect(response.status).toBe(200);
    expect(calls.grants).toEqual([
      { kind: "mcp", ref: "added-app/SEND_MESSAGE", agentId: "bot-1" },
    ]);
  });

  /*
   * THE SERVER HALF ONLY, and this is the test that says so.
   *
   * A grant naming a tool the server has stopped advertising is a supported state — held and not
   * offered, because what a vendor lists today is not what somebody decided yesterday. Checking the
   * tool here would refuse a re-grant of exactly the tool an administrator is trying to restore.
   */
  test("a tool the app no longer advertises is still grantable", async () => {
    const calls = {
      grants: [] as unknown[],
      toolCalls: [] as unknown[],
      serverLookups: [] as unknown[],
    };
    const response = await appWith(calls, ["added-app"]).request(
      "http://openbot.test/grants",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "mcp",
          ref: "added-app/A_TOOL_IT_WITHDREW",
          agentId: "bot-1",
        }),
      },
    );

    expect(response.status).toBe(200);
    expect(calls.grants).toHaveLength(1);
  });

  /*
   * TAKING SOMETHING AWAY IS STILL ALWAYS ALLOWED, which matters more here than anywhere else.
   *
   * The rows this check exists to prevent are the same shape as the rows #572's migration had to
   * delete. Applying the check to a revoke would mean the reason a dead row is wrong is the reason
   * it can never be removed, and an administrator looking at one in the UI would have to wait for
   * somebody to write another migration.
   */
  test("a grant naming no app can still be revoked by hand", async () => {
    const calls = {
      grants: [] as unknown[],
      toolCalls: [] as unknown[],
      revokes: [] as unknown[],
      serverLookups: [] as unknown[],
    };
    const response = await appWith(calls, ["added-app"]).request(
      "http://openbot.test/grants?kind=mcp&ref=missing-app%2FSEND_MESSAGE&agentId=bot-1",
      { method: "DELETE" },
    );

    expect(response.status).toBe(200);
    expect(calls.revokes).toEqual([
      { kind: "mcp", ref: "missing-app/SEND_MESSAGE", agentId: "bot-1" },
    ]);
    // Not even asked: a revoke has nothing to check.
    expect(calls.serverLookups).toEqual([]);
  });
});

describe("DELETE /api/plugins/grants", () => {
  /**
   * Query params are always strings, so truthiness is not enough.
   *
   * `?ref=%20%20` is truthy and used to pass the presence check, delete zero rows by exact
   * match, still write a `plugin_revoked` audit row naming whitespace, and answer `ok:true`.
   * The POST twin already requires trimmed non-empty strings; DELETE requires the same and
   * acts on the trimmed values.
   */
  test.each([
    ["a whitespace ref", "?kind=mcp&ref=%20%20%20&agentId=bot-1"],
    ["a whitespace agentId", "?kind=mcp&ref=tool&agentId=%20%20"],
    ["a missing ref", "?kind=mcp&agentId=bot-1"],
    ["a missing agentId", "?kind=mcp&ref=tool"],
    ["a missing kind", "?ref=tool&agentId=bot-1"],
  ])("refuses %s with 400 and never reaches the store", async (_n, query) => {
    const calls = {
      grants: [] as unknown[],
      toolCalls: [] as unknown[],
      revokes: [] as unknown[],
    };
    const response = await appWith(calls).request(
      `http://openbot.test/grants${query}`,
      { method: "DELETE" },
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "A kind, a ref and a Bot are required.",
    });
    expect(calls.revokes).toEqual([]);
  });

  test("a valid revoke still deletes and trims the values it acts on", async () => {
    const calls = {
      grants: [] as unknown[],
      toolCalls: [] as unknown[],
      revokes: [] as unknown[],
    };
    const response = await appWith(calls).request(
      "http://openbot.test/grants?kind=mcp&ref=%20tool%20&agentId=%20bot-1%20",
      { method: "DELETE" },
    );

    expect(response.status).toBe(200);
    expect(calls.revokes).toEqual([
      { kind: "mcp", ref: "tool", agentId: "bot-1" },
    ]);
  });
});

describe("POST /api/plugins/call", () => {
  test.each([
    ["a number ref", { ref: 123, agentId: "bot-1" }],
    ["an object ref", { ref: {}, agentId: "bot-1" }],
    ["a number agentId", { ref: "tool", agentId: 456 }],
    ["a whitespace ref", { ref: "  ", agentId: "bot-1" }],
  ])("refuses %s with 400 and never reaches the store", async (_n, body) => {
    const calls = { grants: [] as unknown[], toolCalls: [] as unknown[] };
    const response = await appWith(calls).request("http://openbot.test/call", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "A tool and a Bot are required.",
    });
    expect(calls.toolCalls).toEqual([]);
  });
});

describe("POST /api/plugins/skills", () => {
  function skillsApp(calls: { installs: unknown[] }) {
    const store = {
      grant: async () => ({ ok: true }),
      callTool: async () => ({ ok: true }),
      skillOwner: async () => null,
      installSkill: async (input: unknown) => {
        calls.installs.push(input);
      },
      listSkills: async () => [],
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

  /**
   * The body is JSON, so the annotations are wishes.
   *
   * `{"slug":123,...}` is truthy and `RegExp.test` coerces it to `"123"`, so it used to pass
   * validation; `{"summary":{}}` reached the store where the insert threw a 500. Both are caller
   * errors and answer 400 before any refusal check, store write, or audit row.
   */
  test.each([
    ["a number slug", { slug: 123, title: "t", instructions: "i" }],
    ["an object slug", { slug: {}, title: "t", instructions: "i" }],
    ["a number title", { slug: "ok-slug", title: 42, instructions: "i" }],
    [
      "a number instructions",
      { slug: "ok-slug", title: "t", instructions: 42 },
    ],
    [
      "an object summary",
      { slug: "ok-slug", title: "t", instructions: "i", summary: {} },
    ],
    [
      "an array summary",
      { slug: "ok-slug", title: "t", instructions: "i", summary: [] },
    ],
    [
      "a number summary",
      { slug: "ok-slug", title: "t", instructions: "i", summary: 42 },
    ],
    [
      "a whitespace title",
      { slug: "ok-slug", title: "   ", instructions: "i" },
    ],
    [
      "a whitespace instructions",
      { slug: "ok-slug", title: "t", instructions: "  " },
    ],
  ])("refuses %s with 400 and never reaches the store", async (_n, body) => {
    const calls = { installs: [] as unknown[] };
    const response = await skillsApp(calls).request(
      "http://openbot.test/skills",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    );

    expect(response.status).toBe(400);
    expect(calls.installs).toEqual([]);
  });

  test("a well-formed skill still installs", async () => {
    const calls = { installs: [] as unknown[] };
    const response = await skillsApp(calls).request(
      "http://openbot.test/skills",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          slug: "ok-slug",
          title: "t",
          instructions: "i",
          summary: "s",
        }),
      },
    );

    expect(response.status).toBe(200);
    expect(calls.installs).toHaveLength(1);
  });
});
