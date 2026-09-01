import { describe, expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import {
  AgentNotFoundError,
  AgentNotManageableError,
  type AgentProfileStore,
  ProtectedAgentError,
} from "../src/agents/profile-store";
import type {
  AgentProfile,
  CreateAgentInput,
} from "../src/agents/profile-types";
import { createAgentRoutes, parseAgentInput } from "../src/agents/routes";
import { createApp } from "../src/app";
import type { AppVariables, AuthenticatedActor } from "../src/auth/guards";
import { loadConfig } from "../src/config";
import { testEnvironment } from "./support/environment";

const actor = {
  id: "user-1",
  email: "member@openbot.test",
  role: "user",
} as const;

const validInput: CreateAgentInput = {
  name: "Expense Manager",
  title: "Finance Operations",
  roleDescription:
    "Review receipts, categorize expenses, and prepare reimbursement reports.",
  visibility: "private",
};

const ONE_PIXEL_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

function profile(overrides: Partial<AgentProfile> = {}): AgentProfile {
  return {
    id: "agent-1",
    name: validInput.name,
    title: validInput.title,
    roleDescription: validInput.roleDescription,
    avatarSeed: "expense-manager",
    hasCustomAvatar: false,
    avatarUpdatedAt: new Date(0),
    visibility: validInput.visibility,
    ownerUserId: actor.id,
    systemOwned: false,
    hidden: false,
    deletedAt: null,
    ...overrides,
  };
}

type StoreCall = [method: keyof AgentProfileStore, ...arguments_: unknown[]];

function fakeStore(
  overrides: Partial<AgentProfileStore> = {},
): AgentProfileStore & { calls: StoreCall[] } {
  const calls: StoreCall[] = [];
  const base: AgentProfileStore = {
    async list(receivedActor, hidden) {
      calls.push(["list", receivedActor, hidden]);
      return [profile()];
    },
    async get(receivedActor, id) {
      calls.push(["get", receivedActor, id]);
      return profile({ id });
    },
    async avatar(receivedActor, id) {
      calls.push(["avatar", receivedActor, id]);
      return null;
    },
    async getWithin(_executor, receivedActor, id) {
      calls.push(["getWithin", receivedActor, id]);
      return profile({ id });
    },
    async create(receivedActor, input) {
      calls.push(["create", receivedActor, input]);
      return profile({ ...input });
    },
    async update(receivedActor, id, input) {
      calls.push(["update", receivedActor, id, input]);
      return profile({ id, ...input });
    },
    async setAvatar(receivedActor, id, image) {
      calls.push(["setAvatar", receivedActor, id, image]);
      return profile({
        id,
        hasCustomAvatar: image !== null,
        avatarUpdatedAt: new Date(1),
      });
    },
    async duplicate(receivedActor, id) {
      calls.push(["duplicate", receivedActor, id]);
      return profile({ id: `${id}-copy`, visibility: "private" });
    },
    async setHidden(receivedActor, id, hidden) {
      calls.push(["setHidden", receivedActor, id, hidden]);
    },
    async softDelete(receivedActor, id) {
      calls.push(["softDelete", receivedActor, id]);
    },
  };

  return Object.assign(base, overrides, { calls });
}

const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
  context,
  next,
) => {
  context.set("actor", actor);
  await next();
};

function appFor(
  store: AgentProfileStore,
  middleware: MiddlewareHandler<{ Variables: AppVariables }> = requireUser,
) {
  const app = new Hono<{ Variables: AppVariables }>();
  app.route("/", createAgentRoutes(store, middleware));
  return app;
}

async function json(response: Response) {
  return response.json();
}

describe("agent input parser", () => {
  test.each([[null], [[]], ["input"], [42], [true]])(
    "rejects a non-object root: %p",
    (input) => {
      expect(parseAgentInput(input)).toEqual({
        ok: false,
        error: "Agent input must be a JSON object.",
      });
    },
  );

  test.each([
    ["name", undefined, "Name must be text between 1 and 80 characters."],
    ["name", 12, "Name must be text between 1 and 80 characters."],
    ["name", "   ", "Name must be text between 1 and 80 characters."],
    ["name", "n".repeat(81), "Name must be text between 1 and 80 characters."],
    ["title", undefined, "Title must be text between 1 and 120 characters."],
    ["title", false, "Title must be text between 1 and 120 characters."],
    ["title", "\n\t", "Title must be text between 1 and 120 characters."],
    [
      "title",
      "t".repeat(121),
      "Title must be text between 1 and 120 characters.",
    ],
    [
      "roleDescription",
      undefined,
      "Role description must be text between 1 and 1000 characters.",
    ],
    [
      "roleDescription",
      {},
      "Role description must be text between 1 and 1000 characters.",
    ],
    [
      "roleDescription",
      "   ",
      "Role description must be text between 1 and 1000 characters.",
    ],
    [
      "roleDescription",
      "r".repeat(1001),
      "Role description must be text between 1 and 1000 characters.",
    ],
    ["visibility", undefined, "Visibility must be public or private."],
    ["visibility", 1, "Visibility must be public or private."],
    ["visibility", "   ", "Visibility must be public or private."],
    ["visibility", "friends", "Visibility must be public or private."],
  ])("rejects invalid %s values", (field, value, error) => {
    expect(parseAgentInput({ ...validInput, [field]: value })).toEqual({
      ok: false,
      error,
    });
  });

  test.each([
    ["name", "n", "n"],
    ["name", ` ${"n".repeat(80)} `, "n".repeat(80)],
    ["title", "t", "t"],
    ["title", ` ${"t".repeat(120)} `, "t".repeat(120)],
    ["roleDescription", "r", "r"],
    ["roleDescription", ` ${"r".repeat(1000)} `, "r".repeat(1000)],
    ["visibility", " public ", "public"],
    ["visibility", " private ", "private"],
  ])("accepts and trims boundary %s values", (field, value, trimmed) => {
    const result = parseAgentInput({ ...validInput, [field]: value });

    expect(result).toEqual({
      ok: true,
      value: { ...validInput, [field]: trimmed },
    });
  });

  test("trims every accepted field and ignores forged fields", () => {
    expect(
      parseAgentInput({
        name: "  Expense Manager  ",
        title: "  Finance Operations  ",
        roleDescription: "  Reviews receipts.  ",
        visibility: " private ",
        id: "forged-agent",
        ownerUserId: "attacker",
        avatarSeed: "forged-avatar",
        deletedAt: "now",
        systemOwned: true,
        // `endpoint` is a real field for BYO-agent; validation protects it rather than refusing it
        // as a forged field. See agent-endpoint.test.ts.
        endpoint: "https://agents.example.com/ag-ui",
      }),
    ).toEqual({
      ok: true,
      value: {
        name: "Expense Manager",
        title: "Finance Operations",
        roleDescription: "Reviews receipts.",
        visibility: "private",
        endpoint: "https://agents.example.com/ag-ui",
      },
    });
  });
});

describe("agent lifecycle routes", () => {
  test("attaches authentication middleware to every route before calling the store", async () => {
    const store = fakeStore();
    const denied: MiddlewareHandler<{ Variables: AppVariables }> = (context) =>
      Promise.resolve(context.json({ error: "denied" }, 401));
    const app = appFor(store, denied);
    const requests: [string, RequestInit?][] = [
      ["/"],
      ["/agent-1"],
      ["/", { method: "POST", body: JSON.stringify(validInput) }],
      ["/agent-1", { method: "PATCH", body: JSON.stringify(validInput) }],
      ["/agent-1/duplicate", { method: "POST" }],
      ["/agent-1/hide", { method: "POST" }],
      ["/agent-1/unhide", { method: "POST" }],
      ["/agent-1", { method: "DELETE" }],
    ];

    for (const [path, init] of requests) {
      const response = await app.request(`http://openbot.test${path}`, init);
      expect(response.status).toBe(401);
    }
    expect(store.calls).toEqual([]);
  });

  test("uses only the authenticated context actor and parses hidden as exact true", async () => {
    const store = fakeStore();
    const app = appFor(store);

    for (const query of [
      "",
      "?hidden=false",
      "?hidden=True",
      "?hidden=1",
      "?hidden=true",
    ]) {
      expect((await app.request(`http://openbot.test/${query}`)).status).toBe(
        200,
      );
    }

    expect(store.calls).toEqual([
      ["list", actor, false],
      ["list", actor, false],
      ["list", actor, false],
      ["list", actor, false],
      ["list", actor, true],
    ]);
  });

  test("serves every lifecycle route with its contract status and store operation", async () => {
    const store = fakeStore();
    const app = appFor(store);

    const list = await app.request("http://openbot.test/");
    const detail = await app.request("http://openbot.test/agent-1");
    const created = await app.request("http://openbot.test/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(validInput),
    });
    const updated = await app.request("http://openbot.test/agent-1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(validInput),
    });
    const duplicated = await app.request(
      "http://openbot.test/agent-1/duplicate",
      {
        method: "POST",
      },
    );
    const hidden = await app.request("http://openbot.test/agent-1/hide", {
      method: "POST",
    });
    const unhidden = await app.request("http://openbot.test/agent-1/unhide", {
      method: "POST",
    });
    const deleted = await app.request("http://openbot.test/agent-1", {
      method: "DELETE",
    });

    expect(list.status).toBe(200);
    expect(detail.status).toBe(200);
    expect(created.status).toBe(201);
    expect(updated.status).toBe(200);
    expect(duplicated.status).toBe(201);
    expect(hidden.status).toBe(204);
    expect(unhidden.status).toBe(204);
    expect(deleted.status).toBe(204);
    expect(store.calls).toEqual([
      ["list", actor, false],
      ["get", actor, "agent-1"],
      ["create", actor, validInput],
      ["update", actor, "agent-1", validInput],
      ["duplicate", actor, "agent-1"],
      ["setHidden", actor, "agent-1", true],
      ["setHidden", actor, "agent-1", false],
      ["softDelete", actor, "agent-1"],
    ]);
  });

  test("validates and stores a coworker avatar independently of profile edits", async () => {
    const store = fakeStore();
    const app = appFor(store);

    const saved = await app.request("http://openbot.test/agent-1/avatar", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ image: ONE_PIXEL_PNG }),
    });
    expect(saved.status).toBe(200);
    expect(store.calls).toEqual([
      ["setAvatar", actor, "agent-1", ONE_PIXEL_PNG],
    ]);
    expect(await json(saved)).toEqual({
      agent: expect.objectContaining({
        id: "agent-1",
        avatarUrl: expect.stringContaining(
          "/api/agents/agent-1/avatar/image?v=",
        ),
      }),
    });

    store.calls.length = 0;
    const refused = await app.request("http://openbot.test/agent-1/avatar", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        image: "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=",
      }),
    });
    expect(refused.status).toBe(400);
    expect(store.calls).toEqual([]);
  });

  test("serves avatar bytes only through an accessible coworker", async () => {
    const store = fakeStore({
      async avatar(receivedActor, id) {
        store.calls.push(["avatar", receivedActor, id]);
        return ONE_PIXEL_PNG;
      },
    });

    const response = await appFor(store).request(
      "http://openbot.test/agent-1/avatar/image?v=current",
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(
      Buffer.from(ONE_PIXEL_PNG.split(",")[1], "base64"),
    );
    expect(store.calls).toEqual([["avatar", actor, "agent-1"]]);
  });

  test("projects exact DTO fields and computes permissions for the authenticated actor", async () => {
    const store = fakeStore({
      async list() {
        return [
          profile(),
          profile({ id: "agent-2", ownerUserId: "user-2" }),
          profile({
            id: "system-agent",
            ownerUserId: null,
            systemOwned: true,
            visibility: "public",
          }),
        ];
      },
    });

    const response = await appFor(store).request("http://openbot.test/");

    expect(await json(response)).toEqual({
      agents: [
        {
          id: "agent-1",
          name: validInput.name,
          title: validInput.title,
          roleDescription: validInput.roleDescription,
          avatarSeed: "expense-manager",
          avatarUrl: null,
          visibility: "private",
          hidden: false,
          systemOwned: false,
          canManage: true,
          canCustomizeAvatar: true,
          mine: true,
          builtIn: false,
        },
        {
          id: "agent-2",
          name: validInput.name,
          title: validInput.title,
          roleDescription: validInput.roleDescription,
          avatarSeed: "expense-manager",
          avatarUrl: null,
          visibility: "private",
          hidden: false,
          systemOwned: false,
          canManage: false,
          canCustomizeAvatar: false,
          mine: false,
          builtIn: false,
        },
        {
          id: "system-agent",
          name: validInput.name,
          title: validInput.title,
          roleDescription: validInput.roleDescription,
          avatarSeed: "expense-manager",
          avatarUrl: null,
          visibility: "public",
          hidden: false,
          systemOwned: true,
          canManage: false,
          canCustomizeAvatar: false,
          mine: false,
          builtIn: false,
        },
      ],
    });
  });

  test("separates ownership from permission for an administrator", async () => {
    const administrator: AuthenticatedActor = {
      id: "admin-1",
      email: "admin@openbot.test",
      role: "admin",
    };
    const requireAdministrator: MiddlewareHandler<{
      Variables: AppVariables;
    }> = async (context, next) => {
      context.set("actor", administrator);
      await next();
    };
    const store = fakeStore({
      async list() {
        return [
          profile({ id: "theirs", ownerUserId: "user-1" }),
          profile({ id: "ours", ownerUserId: administrator.id }),
        ];
      },
    });

    const body = (await json(
      await appFor(store, requireAdministrator).request("http://openbot.test/"),
    )) as { agents: { id: string; canManage: boolean; mine: boolean }[] };

    // An administrator may manage everybody's coworkers but only created their own. A roster that
    // split on `canManage` would file somebody else's private coworker under theirs.
    expect(body.agents).toEqual([
      expect.objectContaining({ id: "theirs", canManage: true, mine: false }),
      expect.objectContaining({ id: "ours", canManage: true, mine: true }),
    ]);
  });

  test("never forwards forged create or update fields", async () => {
    const store = fakeStore();
    const app = appFor(store);
    const body = {
      name: "  Expense Manager  ",
      title: "  Finance Operations  ",
      roleDescription: `  ${validInput.roleDescription}  `,
      visibility: " private ",
      id: "forged-agent",
      ownerUserId: "attacker",
      avatarSeed: "forged-avatar",
      deletedAt: "now",
      systemOwned: true,
      // A real field now, not a forged one; the rest of this list still is.
      endpoint: "https://agents.example.com/ag-ui",
    };

    for (const [path, method] of [
      ["/", "POST"],
      ["/agent-1", "PATCH"],
    ] as const) {
      const response = await app.request(`http://openbot.test${path}`, {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(method === "POST" ? 201 : 200);
    }

    // The endpoint reaches the store because it is a real field; everything else forged does not.
    const expected = {
      ...validInput,
      endpoint: "https://agents.example.com/ag-ui",
    };
    expect(store.calls).toEqual([
      ["create", actor, expected],
      ["update", actor, "agent-1", expected],
    ]);
  });

  test.each([
    ["POST", "/"],
    ["PATCH", "/agent-1"],
  ])("requires a valid full JSON object for %s %s", async (method, path) => {
    const store = fakeStore();
    const app = appFor(store);
    const malformed = await app.request(`http://openbot.test${path}`, {
      method,
      headers: { "content-type": "application/json" },
      body: "{",
    });
    const partial = await app.request(`http://openbot.test${path}`, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Only a name" }),
    });

    expect(malformed.status).toBe(400);
    expect(await json(malformed)).toEqual({
      error: "Agent input must be a JSON object.",
    });
    expect(partial.status).toBe(400);
    expect(await json(partial)).toEqual({
      error: "Title must be text between 1 and 120 characters.",
    });
    expect(store.calls).toEqual([]);
  });

  test("returns 404 when get returns null", async () => {
    const store = fakeStore({ get: async () => null });

    const response = await appFor(store).request("http://openbot.test/missing");

    expect(response.status).toBe(404);
    expect(await json(response)).toEqual({ error: "Agent not found." });
  });

  test.each([
    [new AgentNotFoundError("agent-1"), 404, "Agent not found."],
    [
      new AgentNotManageableError("agent-1"),
      403,
      "You do not have permission to manage this agent.",
    ],
    [
      new ProtectedAgentError("agent-1"),
      403,
      "System-owned agents are protected.",
    ],
  ])("maps known store errors", async (error, status, message) => {
    const store = fakeStore({
      update: async () => {
        throw error;
      },
    });

    const response = await appFor(store).request(
      "http://openbot.test/agent-1",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(validInput),
      },
    );

    expect(response.status).toBe(status);
    expect(await json(response)).toEqual({ error: message });
  });

  test("rethrows unexpected errors to the outer Hono error handler", async () => {
    const store = fakeStore({
      duplicate: async () => {
        throw new Error("database disconnected");
      },
    });
    const app = appFor(store);
    app.onError((error, context) =>
      context.json({ sentinel: error.message }, 599),
    );

    const response = await app.request(
      "http://openbot.test/agent-1/duplicate",
      {
        method: "POST",
      },
    );

    expect(response.status).toBe(599);
    expect(await json(response)).toEqual({ sentinel: "database disconnected" });
  });
});

describe("agent route composition", () => {
  test("mounts the store behind createApp authentication with the derived actor", async () => {
    const store = fakeStore();
    let session: {
      user: { id: string; email: string; name: string; image: string };
    } | null = null;
    const app = createApp(
      loadConfig(testEnvironment()),
      {
        handler: () => new Response(null, { status: 204 }),
        api: { getSession: async () => session },
      },
      { rolesForUser: async () => ["user"] },
      /*
       * Positions 4-9: auditReader, credentialService, packageStatusReader, copilotHandler,
       * computerGateway, computerPolicy. `store` is position 10, agentProfileStore.
       *
       * Six placeholders, down from seven on both sides of the merge that produced this. Each side
       * had removed one parameter — `connectorService` here, `computerClient` on main — so both runs
       * were seven long and textually identical, and only the comment conflicted. Taking either
       * side's run would have left `store` one slot too far along, in `channelEvents`, where nothing
       * would have complained: every parameter from 4 on is optional, so a misplaced argument is a
       * silent pass and the assertions below would fail for no visible reason.
       */
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      store,
    );

    const unauthenticated = await app.request("http://openbot.test/api/agents");
    expect(unauthenticated.status).toBe(401);
    expect(store.calls).toEqual([]);

    session = {
      user: {
        id: actor.id,
        email: actor.email,
        name: "OpenBot Member",
        image: "https://example.test/member.png",
      },
    };
    const authenticated = await app.request("http://openbot.test/api/agents");

    expect(authenticated.status).toBe(200);
    expect(store.calls).toEqual([
      [
        "list",
        {
          ...actor,
          name: "OpenBot Member",
          image: "https://example.test/member.png",
        },
        false,
      ],
    ]);
  });

  test("leaves agent routes unmounted when createApp has no store", async () => {
    const app = createApp(loadConfig(testEnvironment()));

    const response = await app.request("http://openbot.test/api/agents");

    expect(response.status).toBe(404);
  });
});

/*
 * The screen that grants one Bot the right to address another reads this, so what it renders is
 * decided here rather than in the browser: whether the capability is on at all, and whether the
 * person looking may change any of it.
 */
describe("which Bots a Bot may hand work to", () => {
  const admin = {
    id: "admin-1",
    email: "a@openbot.test",
    role: "admin",
  } as const;

  function appWith(
    handoff: Parameters<typeof createAgentRoutes>[5],
    who: { id: string; email: string; role: "admin" | "user" } = admin,
  ) {
    const app = new Hono<{ Variables: AppVariables }>();
    const asWho: MiddlewareHandler<{ Variables: AppVariables }> = async (
      context,
      next,
    ) => {
      context.set("actor", who);
      await next();
    };
    app.route(
      "/",
      createAgentRoutes(
        fakeStore(),
        asWho,
        false,
        undefined,
        new Set(),
        handoff,
      ),
    );
    return app;
  }

  test("reports the grants and that an administrator may change them", async () => {
    const app = appWith({
      enabled: true,
      reachableFrom: async () => ["knowledge"],
    });

    const body = (await json(
      await app.request("/general-assistant/handoff"),
    )) as {
      handoff: { enabled: boolean; canGrant: boolean; reachable: string[] };
    };

    expect(body.handoff).toEqual({
      enabled: true,
      canGrant: true,
      reachable: ["knowledge"],
      // No runsHere reader was wired, and a Bot nothing can vouch for is not offered grants.
      grantable: false,
    });
  });

  test("somebody who is not an administrator may read it and not change it", async () => {
    const app = appWith(
      { enabled: true, reachableFrom: async () => ["knowledge"] },
      actor,
    );

    const body = (await json(
      await app.request("/general-assistant/handoff"),
    )) as {
      handoff: { canGrant: boolean };
    };

    expect(body.handoff.canGrant).toBe(false);
  });

  /*
   * A deployment with the caps at zero, or with no plugin store to read a grant from, has the
   * capability switched off. Reported rather than left to the screen to infer, because a switch
   * wired to nothing is the thing this says out loud.
   */
  test("says the capability is off when nothing can grant it", async () => {
    const app = appWith(undefined);

    const body = (await json(
      await app.request("/general-assistant/handoff"),
    )) as {
      handoff: { enabled: boolean; reachable: string[] };
    };

    expect(body.handoff.enabled).toBe(false);
    expect(body.handoff.reachable).toEqual([]);
  });

  test("a Bot the person may not see is not found, rather than described", async () => {
    const app = new Hono<{ Variables: AppVariables }>();
    app.route(
      "/",
      createAgentRoutes(
        fakeStore({
          async get() {
            return null;
          },
        }),
        requireUser,
        false,
        undefined,
        new Set(),
        { enabled: true, reachableFrom: async () => ["knowledge"] },
      ),
    );

    const response = await app.request("/somebody-elses/handoff");

    expect(response.status).toBe(404);
  });
});
