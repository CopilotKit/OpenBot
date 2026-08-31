import { describe, expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { AppVariables } from "../src/auth/guards";
import { createComponentRoutes } from "../src/components/routes";
import { createComputerRoutes } from "../src/computer/routes";
import { createPluginRoutes } from "../src/plugins/routes";

/**
 * Whether the person asking may act as the Bot they named.
 *
 * `requireUser` answers "is this a signed-in person", which is a different question and the only one
 * these surfaces used to ask. A Bot id travels in the URL for the computer and in the body for a tool
 * call, so without this a signed-in person acts as any Bot in the deployment, including a private one
 * belonging to somebody else: they reset its browser, drive its pages, and fire its granted MCP tools
 * against the deployment's own credential.
 *
 * The rule itself is not new. `canAccessAgent` has always said public, or owner, or administrator,
 * and the store's read path has always filtered on it. These are the callers that never asked.
 */

/** A signed-in person with the base role, which is the lowest privilege that gets past the guard. */
function signedIn(
  id: string,
  role: "user" | "admin" = "user",
): MiddlewareHandler<{ Variables: AppVariables }> {
  return async (context, next) => {
    context.set("actor", { id, email: `${id}@openbot.test`, role });
    await next();
  };
}

/**
 * Owner sees their own Bot, an administrator sees every Bot, nobody else sees it. Stands in for the
 * store's access filter, which decides the same three ways.
 */
const ownedBy =
  (owner: string) =>
  async (actor: { id: string; role: string }, botId: string) =>
    botId === "sales" && (actor.id === owner || actor.role === "admin");

describe("the computer surface", () => {
  function app(actorId: string, role: "user" | "admin" = "user") {
    const reached: string[] = [];
    const gateway = {
      resetComputer: async (botId: string) => {
        reached.push(`reset:${botId}`);
        return { cleared: true };
      },
      read: async (botId: string) => {
        reached.push(`read:${botId}`);
        return { text: "a page" };
      },
      screenshot: async (botId: string) => {
        reached.push(`screenshot:${botId}`);
        return { image: "" };
      },
      status: async (botId: string) => {
        reached.push(`status:${botId}`);
        return { botId, state: "ready" };
      },
    } as never;

    const routes = createComputerRoutes(
      gateway,
      {
        authored: () => ({ mode: "enforce", deny: [], allow: [] }),
        get: () => ({ mode: "enforce", deny: [], allow: [] }),
      } as never,
      signedIn(actorId, role),
      ownedBy("owner"),
    );
    return {
      reached,
      hono: new Hono().route("/api/computers", routes),
    };
  }

  test("lets the owner act on their own Bot", async () => {
    const { hono, reached } = app("owner");
    const response = await hono.request(
      "http://t/api/computers/sales/computers/reset",
      { method: "POST" },
    );

    expect(response.status).toBe(200);
    expect(reached).toEqual(["reset:sales"]);
  });

  test("refuses somebody else's Bot, and does not act first", async () => {
    const { hono, reached } = app("stranger");
    const response = await hono.request(
      "http://t/api/computers/sales/computers/reset",
      { method: "POST" },
    );

    expect(response.status).toBe(404);
    // The refusal has to happen before the gateway is called. A check that runs after the browser
    // has already been wiped is not a check.
    expect(reached).toEqual([]);
  });

  // Reading is not a lesser question here. A screenshot of somebody's Bot mid-task is the contents
  // of whatever page it is signed into.
  test.each([
    ["/api/computers/sales/read", "GET"],
    ["/api/computers/sales/screenshot", "GET"],
    ["/api/computers/sales/status", "GET"],
  ])("refuses %s for somebody else's Bot", async (path, method) => {
    const { hono, reached } = app("stranger");
    const response = await hono.request(`http://t${path}`, { method });

    expect(response.status).toBe(404);
    expect(reached).toEqual([]);
  });

  // An administrator already reaches every Bot everywhere else in the product. This must not become
  // the one surface where they cannot.
  test("still lets an administrator act on any Bot", async () => {
    const { hono, reached } = app("someone-else", "admin");
    const response = await hono.request(
      "http://t/api/computers/sales/computers/reset",
      { method: "POST" },
    );

    expect(response.status).toBe(200);
    expect(reached).toEqual(["reset:sales"]);
  });

  test("says nothing about whether that Bot exists", async () => {
    const { hono } = app("stranger");
    const missing = await hono.request(
      "http://t/api/computers/no-such-bot/read",
    );
    const private_ = await hono.request("http://t/api/computers/sales/read");

    // Same answer either way, so the surface is not a way to enumerate other people's Bots.
    expect(private_.status).toBe(missing.status);
    expect(await private_.text()).toBe(await missing.text());
  });
});

/*
 * The deployment paths, and everything that merely starts with one.
 *
 * `/policy` and `/fleet` are this router's own and are not about a Bot, so the guard steps aside for
 * them. What it must not step aside for is the subtree: `/policy/status` is `/:botId/status` with a
 * Bot called `policy`, and treating the whole subtree as deployment-owned hands that Bot's computer
 * to anybody who can sign in without the guard being asked at all. Bot ids are reserved against
 * these names at the other end of the system so no such Bot can exist; this is the half that holds
 * if one ever does.
 */
describe("a path that starts with a deployment route", () => {
  function app(role: "user" | "admin" = "user") {
    const reached: string[] = [];
    const asked: string[] = [];
    const gateway = {
      status: async (botId: string) => {
        reached.push(`status:${botId}`);
        return { botId, state: "ready" };
      },
      screenshot: async (botId: string) => {
        reached.push(`screenshot:${botId}`);
        return { image: "" };
      },
      computers: async () => [],
    } as never;
    const routes = createComputerRoutes(
      gateway,
      {
        authored: () => ({ mode: "enforce", deny: [], allow: [] }),
        get: () => ({ mode: "enforce", deny: [], allow: [] }),
      } as never,
      signedIn("somebody", role),
      // Denies everything, so anything that answers got past the guard rather than through it.
      async (_actor, botId: string) => {
        asked.push(botId);
        return false;
      },
    );
    return { reached, asked, hono: new Hono().route("/api/computers", routes) };
  }

  for (const [name, path] of [
    ["policy", "/api/computers/policy/status"],
    ["fleet", "/api/computers/fleet/status"],
    ["policy, deeper", "/api/computers/policy/computers"],
  ] as const) {
    test(`refuses ${name} as a Bot path, and asks first`, async () => {
      const { hono, reached, asked } = app();
      const response = await hono.request(path);

      expect(response.status).toBe(404);
      expect(reached).toEqual([]);
      // Asked, rather than skipped: the guard is what produced the 404.
      expect(asked.length).toBe(1);
    });
  }

  test("still serves the fleet listing itself", async () => {
    // The permissive half. A guard that refused these would have closed the hole by breaking the
    // two routes it exists to let through.
    const { hono, asked } = app("admin");
    const response = await hono.request("http://t/api/computers/fleet");

    expect(response.status).toBe(200);
    expect(asked).toEqual([]);
  });

  test("still serves the policy route itself", async () => {
    const { hono, asked } = app("admin");
    const response = await hono.request("http://t/api/computers/policy");

    expect(response.status).toBe(200);
    expect(asked).toEqual([]);
  });

  test("a trailing slash is not a way back into the subtree", async () => {
    // `/policy/` matches no route in this router either way, which is the answer wanted here. What
    // this pins is that it never reaches the computer as a Bot called `policy`.
    const { hono, reached } = app("admin");
    const response = await hono.request("http://t/api/computers/policy/");

    expect(reached).toEqual([]);
    expect(response.status).toBe(404);
  });
});

describe("the computer surface, unauthenticated", () => {
  // The access middleware carries the session guard for everything under a Bot id, so the guard has
  // to still refuse a caller with no session at all, and refuse it before anything is asked about a
  // Bot.
  test("refuses before it asks whose Bot it is", async () => {
    const asked: string[] = [];
    const reached: string[] = [];
    const routes = createComputerRoutes(
      {
        read: async (botId: string) => {
          reached.push(botId);
          return { text: "" };
        },
      } as never,
      {
        authored: () => ({ mode: "enforce", deny: [], allow: [] }),
        get: () => ({ mode: "enforce", deny: [], allow: [] }),
      } as never,
      async (context) =>
        context.json({ error: "Authentication required." }, 401),
      async (_actor, botId) => {
        asked.push(botId);
        return true;
      },
    );
    const hono = new Hono().route("/api/computers", routes);

    const response = await hono.request("http://t/api/computers/sales/read");

    expect(response.status).toBe(401);
    expect(asked).toEqual([]);
    expect(reached).toEqual([]);
  });
});

describe("calling a tool as a Bot", () => {
  function app(actorId: string) {
    const called: string[] = [];
    const store = {
      callTool: async (input: { ref: string; botId: string }) => {
        called.push(`${input.ref}@${input.botId}`);
        return { ok: true };
      },
      listForAgent: async (agentId: string) => {
        called.push(`list:${agentId}`);
        return { mcp: [], skills: [] };
      },
      listServers: async () => [],
      listSkills: async () => [],
    } as never;

    return {
      called,
      hono: new Hono().route(
        "/api/plugins",
        createPluginRoutes(store, signedIn(actorId), ownedBy("owner")),
      ),
    };
  }

  test("lets the owner call a tool as their own Bot", async () => {
    const { hono, called } = app("owner");
    const response = await hono.request("http://t/api/plugins/call", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ref: "mcp__slack__post", agentId: "sales" }),
    });

    expect(response.status).toBe(200);
    expect(called).toEqual(["mcp__slack__post@sales"]);
  });

  // What a Bot holds is a fact about that Bot, the same as its components. Left open, this says which
  // tools somebody else's private coworker has been granted.
  test("refuses to list what somebody else's Bot holds", async () => {
    const { hono, called } = app("stranger");
    const response = await hono.request("http://t/api/plugins/for/sales");

    expect(response.status).toBe(404);
    expect(called).toEqual([]);
  });

  test("lets the owner list what their own Bot holds", async () => {
    const { hono } = app("owner");
    const response = await hono.request("http://t/api/plugins/for/sales");

    expect(response.status).toBe(200);
  });

  test("refuses a tool call as somebody else's Bot, and does not call it", async () => {
    const { hono, called } = app("stranger");
    const response = await hono.request("http://t/api/plugins/call", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ref: "mcp__slack__post", agentId: "sales" }),
    });

    expect(response.status).toBe(404);
    // The grant belongs to the Bot, so the vendor call would have gone out on the deployment's
    // credential. Nothing may reach the vendor before the caller is checked.
    expect(called).toEqual([]);
  });
});

describe("components, which a Bot answers with", () => {
  function app(actorId: string) {
    const touched: string[] = [];
    const store = {
      listForAgent: async (agentId: string) => {
        touched.push(`list:${agentId}`);
        return [{ name: "chart" }];
      },
      decide: async (name: string, agentId: string) => {
        touched.push(`decide:${name}:${agentId}`);
        return { allowed: true };
      },
      mayCall: async () => true,
      callFunction: async () => {
        touched.push("callFunction");
        return { rows: [] };
      },
    } as never;

    return {
      touched,
      hono: new Hono().route(
        "/api/components",
        createComponentRoutes(
          store,
          signedIn(actorId),
          undefined,
          ownedBy("owner"),
        ),
      ),
    };
  }

  test("lets the owner ask about their own Bot", async () => {
    const { hono, touched } = app("owner");
    const response = await hono.request(
      "http://t/api/components/for-agent/sales",
    );

    expect(response.status).toBe(200);
    expect(touched).toEqual(["list:sales"]);
  });

  // What a Bot may draw is a fact about that Bot. Listing it for a coworker somebody else owns says
  // which components they have been granted, which is the same leak the roster refuses.
  test("refuses to list somebody else's Bot components", async () => {
    const { hono, touched } = app("stranger");
    const response = await hono.request(
      "http://t/api/components/for-agent/sales",
    );

    expect(response.status).toBe(404);
    expect(touched).toEqual([]);
  });

  test("refuses a decision asked as somebody else's Bot", async () => {
    const { hono, touched } = app("stranger");
    const response = await hono.request(
      "http://t/api/components/chart/decision",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agentId: "sales" }),
      },
    );

    expect(response.status).toBe(404);
    expect(touched).toEqual([]);
  });

  // The one that runs something. A grant belongs to the Bot, so without this the caller borrows it.
  test("refuses a data function called as somebody else's Bot", async () => {
    const { hono, touched } = app("stranger");
    const response = await hono.request("http://t/api/components/chart/call", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agentId: "sales", function: "rows", args: {} }),
    });

    expect(response.status).toBe(404);
    expect(touched).toEqual([]);
  });
});
