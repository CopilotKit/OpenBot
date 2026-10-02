import { describe, expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { AppVariables } from "../src/auth/guards";
import type { BotAccessCheck } from "../src/plugins/routes";
import { createPluginRoutes } from "../src/plugins/routes";
import type { PluginStore } from "../src/plugins/store";
import { createComponentRoutes } from "../src/components/routes";
import { ComponentNotFoundError } from "../src/components/store";

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

function pluginAppWith(calls: { skills: unknown[] }) {
  const store = {
    installSkill: async (input: unknown) => {
      calls.skills.push(input);
      return { ok: true };
    },
    listSkills: async () => [],
  } as unknown as PluginStore;
  return createPluginRoutes(store, requireUser, canUseBot);
}

function componentAppWith(calls: {
  grants: unknown[];
  revokes: unknown[];
  revokeFunctions: unknown[];
}) {
  const store = {
    grant: async (name: unknown, agentId: unknown) => {
      calls.grants.push({ name, agentId });
    },
    revoke: async (name: unknown, agentId: unknown) => {
      calls.revokes.push({ name, agentId });
    },
    revokeFunction: async (name: unknown, fn: unknown) => {
      calls.revokeFunctions.push({ name, fn });
    },
  };
  const app = new Hono<{ Variables: AppVariables }>();
  app.use(requireUser);
  app.route(
    "/",
    createComponentRoutes(store as never, requireUser, undefined, canUseBot),
  );
  return app;
}

const skillBody = {
  slug: "my-skill",
  title: "My skill",
  instructions: "Do the thing.",
};

/**
 * `tools` used to silently drop mistyped entries, so `{"tools":[123,null,{}]}` installed a skill
 * declaring nothing and answered success. Every entry must now be a non-empty string, and
 * `global` must be a boolean, so `"yes"` cannot mint a deployment-wide skill.
 */
describe("POST /api/plugins/skills tools/global", () => {
  test.each([
    ["a number entry", [123]],
    ["a null entry", [null]],
    ["an object entry", [{}]],
    ["a whitespace entry", ["   "]],
    ["a mixed list", ["a/b", 42]],
  ])("refuses tools with %s and installs nothing", async (_n, tools) => {
    const calls = { skills: [] as unknown[] };
    const response = await pluginAppWith(calls).request(
      "http://openbot.test/skills",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...skillBody, tools }),
      },
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "Tools are a list of serverId/toolName references.",
    });
    expect(calls.skills).toEqual([]);
  });

  test.each([
    ["a string global", "yes"],
    ["a number global", 1],
  ])("refuses %s and installs nothing", async (_n, global) => {
    const calls = { skills: [] as unknown[] };
    const response = await pluginAppWith(calls).request(
      "http://openbot.test/skills",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...skillBody, global }),
      },
    );
    expect(response.status).toBe(400);
    expect(calls.skills).toEqual([]);
  });

  test("trims tool refs on the happy path", async () => {
    const calls = { skills: [] as unknown[] };
    const response = await pluginAppWith(calls).request(
      "http://openbot.test/skills",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...skillBody, tools: ["  a/b  "] }),
      },
    );
    expect(response.status).toBe(200);
    expect(calls.skills[0]).toMatchObject({ tools: ["a/b"] });
  });
});

/**
 * A whitespace-only Bot id is truthy and used to pass the grant check, writing a grant row (or
 * an audit row on revoke) naming nothing. Param routes never checked at all.
 */
describe("component grants/functions", () => {
  test("refuses a whitespace agentId on grant", async () => {
    const calls = {
      grants: [],
      revokes: [],
      revokeFunctions: [],
    } as unknown as {
      grants: unknown[];
      revokes: unknown[];
      revokeFunctions: unknown[];
    };
    const response = await componentAppWith(calls).request(
      "http://openbot.test/widget/grants",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agentId: "   " }),
      },
    );
    expect(response.status).toBe(400);
    expect(calls.grants).toEqual([]);
  });

  test("trims the agentId on grant", async () => {
    const calls = {
      grants: [],
      revokes: [],
      revokeFunctions: [],
    } as unknown as {
      grants: unknown[];
      revokes: unknown[];
      revokeFunctions: unknown[];
    };
    const response = await componentAppWith(calls).request(
      "http://openbot.test/widget/grants",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agentId: "  bot-1  " }),
      },
    );
    expect(response.status).toBe(200);
    expect(calls.grants).toEqual([{ name: "widget", agentId: "bot-1" }]);
  });

  test("refuses a whitespace agentId on revoke", async () => {
    const calls = {
      grants: [],
      revokes: [],
      revokeFunctions: [],
    } as unknown as {
      grants: unknown[];
      revokes: unknown[];
      revokeFunctions: unknown[];
    };
    const response = await componentAppWith(calls).request(
      "http://openbot.test/widget/grants/%20%20%20",
      { method: "DELETE" },
    );
    expect(response.status).toBe(400);
    expect(calls.revokes).toEqual([]);
  });
});

/**
 * `DELETE /:name/functions/:function` was the one grant write that never asked whether the component
 * exists. Against a name nobody has, it deleted nothing, answered `revoked: true` and wrote
 * `component.function_revoked` for a component that was never there. Its siblings answer 404.
 */
describe("DELETE /:name/functions/:function", () => {
  function appWithComponents(known: string[]) {
    const audited: { eventType: string; targetId: string }[] = [];
    const revoked: unknown[] = [];
    const store = {
      revokeFunction: async (name: string, fn: string) => {
        if (!known.includes(name)) throw new ComponentNotFoundError(name);
        revoked.push({ name, fn });
      },
    };
    const auditStore = {
      insert: async (event: { eventType: string; targetId: string }) => {
        audited.push({ eventType: event.eventType, targetId: event.targetId });
      },
    };
    const app = new Hono<{ Variables: AppVariables }>();
    app.use(requireUser);
    app.route(
      "/",
      createComponentRoutes(
        store as never,
        requireUser,
        auditStore as never,
        canUseBot,
      ),
    );
    return { app, audited, revoked };
  }

  test("answers 404 for a component that does not exist, and records nothing", async () => {
    const { app, audited, revoked } = appWithComponents(["widget"]);

    const response = await app.request(
      "http://openbot.test/nothing/functions/botActivity",
      { method: "DELETE" },
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: "No component is called nothing.",
    });
    expect(revoked).toEqual([]);
    expect(audited).toEqual([]);
  });

  test("revokes and records for a component that does", async () => {
    const { app, audited, revoked } = appWithComponents(["widget"]);

    const response = await app.request(
      "http://openbot.test/widget/functions/botActivity",
      { method: "DELETE" },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ revoked: true });
    expect(revoked).toEqual([{ name: "widget", fn: "botActivity" }]);
    expect(audited).toEqual([
      { eventType: "component.function_revoked", targetId: "widget" },
    ]);
  });
});
