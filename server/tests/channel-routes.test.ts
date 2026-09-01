import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import {
  AgentNotFoundError,
  createAgentProfileStore,
} from "../src/agents/profile-store";
import type { AgentActor } from "../src/agents/profile-types";
import { createApp } from "../src/app";
import type { AuditEventInput, AuditStore } from "../src/audit";
import { DEV_ACTOR } from "../src/auth/dev-actor";
import type { AppVariables } from "../src/auth/guards";
import {
  type AgentChannel,
  ChannelNotFoundError,
  ChannelPackageOwnedError,
  type ChannelStore,
  createChannelRoutes,
  createChannelStore,
  parseChannelInput,
} from "../src/channels/routes";
import { createThreadIdentity } from "../src/channels/thread-identity";
import { loadConfig } from "../src/config";
import { createDatabase } from "../src/db/client";
import {
  agentProfiles,
  agents,
  channelAgents,
  channelMemberships,
  channels,
  deploymentPackages,
  intelligenceChannelMappings,
  users,
} from "../src/db/schema";
import { TEST_POOL } from "./support/database";
import { testEnvironment } from "./support/environment";

const actor = {
  id: "user-1",
  email: "member@openbot.test",
  role: "user",
} as const;

function channel(overrides: Partial<AgentChannel> = {}): AgentChannel {
  return {
    id: "channel-1",
    name: "Assistant channel",
    agentIds: ["agent-1", "agent-2"],
    threadId: "thread-1",
    active: true,
    ...overrides,
  };
}

type StoreCall = [method: keyof ChannelStore, ...arguments_: unknown[]];

function fakeStore(
  overrides: Partial<ChannelStore> = {},
): ChannelStore & { calls: StoreCall[] } {
  const calls: StoreCall[] = [];
  const base: ChannelStore = {
    async create(receivedActor, agentIds) {
      calls.push(["create", receivedActor, agentIds]);
      return channel({ agentIds });
    },
    async get(receivedActor, id) {
      calls.push(["get", receivedActor, id]);
      return channel({ id });
    },
    async setPinned(receivedActor, id, pinned) {
      calls.push(["setPinned", receivedActor, id, pinned]);
    },
    async markRead(receivedActor, id) {
      calls.push(["markRead", receivedActor, id]);
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
  store: ChannelStore,
  middleware: MiddlewareHandler<{ Variables: AppVariables }> = requireUser,
) {
  const app = new Hono<{ Variables: AppVariables }>();
  app.route("/", createChannelRoutes(store, middleware));
  return app;
}

async function json(response: Response) {
  return response.json();
}

describe("channel input parser", () => {
  test.each([[null], [[]], ["input"], [42], [true]])(
    "rejects a non-object root: %p",
    (input) => {
      expect(parseChannelInput(input)).toEqual({
        ok: false,
        error: "Channel input must be a JSON object.",
      });
    },
  );

  test.each([
    [undefined, "Agent IDs must be a non-empty array."],
    [null, "Agent IDs must be a non-empty array."],
    ["agent-1", "Agent IDs must be a non-empty array."],
    [{}, "Agent IDs must be a non-empty array."],
    [[], "Agent IDs must be a non-empty array."],
  ])("rejects invalid agentIds: %p", (agentIds, error) => {
    expect(parseChannelInput({ agentIds })).toEqual({ ok: false, error });
  });

  test.each([
    [[""], "Agent IDs must be non-empty strings."],
    [["  "], "Agent IDs must be non-empty strings."],
    [[1], "Agent IDs must be non-empty strings."],
    [[false], "Agent IDs must be non-empty strings."],
    [[null], "Agent IDs must be non-empty strings."],
    [[{}], "Agent IDs must be non-empty strings."],
    [["agent-1", " agent-1 "], "Agent IDs must be unique."],
  ])("rejects invalid agent ID members: %p", (agentIds, error) => {
    expect(parseChannelInput({ agentIds })).toEqual({ ok: false, error });
  });

  test("trims, sorts, and whitelists channel input", () => {
    expect(
      parseChannelInput({
        agentIds: [" agent-2 ", "agent-1"],
        id: "forged-channel",
        name: "forged name",
        threadId: "forged-thread",
        active: false,
      }),
    ).toEqual({ ok: true, value: { agentIds: ["agent-1", "agent-2"] } });
  });
});

describe("channel routes", () => {
  test("attaches authentication middleware to every route before calling the store", async () => {
    const store = fakeStore();
    const denied: MiddlewareHandler<{ Variables: AppVariables }> = (context) =>
      Promise.resolve(context.json({ error: "denied" }, 401));
    const app = appFor(store, denied);

    const created = await app.request("http://openbot.test/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agentIds: ["agent-1"] }),
    });
    const fetched = await app.request("http://openbot.test/channel-1");

    expect(created.status).toBe(401);
    expect(fetched.status).toBe(401);
    expect(store.calls).toEqual([]);
  });

  test("uses the authenticated context actor and canonical agent IDs", async () => {
    const store = fakeStore();
    const app = appFor(store);

    const created = await app.request("http://openbot.test/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agentIds: [" agent-2 ", "agent-1"] }),
    });
    const fetched = await app.request("http://openbot.test/channel-1");

    expect(created.status).toBe(201);
    expect(fetched.status).toBe(200);
    expect(store.calls).toEqual([
      ["create", actor, ["agent-1", "agent-2"]],
      ["get", actor, "channel-1"],
    ]);
  });

  test("returns only the channel DTO for create and get", async () => {
    const store = fakeStore({
      async create(_actor, agentIds) {
        return Object.assign(channel({ agentIds }), { ownerUserId: "user-1" });
      },
      async get() {
        return Object.assign(channel(), { internalState: "hidden" });
      },
    });
    const app = appFor(store);

    const created = await app.request("http://openbot.test/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agentIds: ["agent-1"] }),
    });
    const fetched = await app.request("http://openbot.test/channel-1");

    expect(created.status).toBe(201);
    expect(await json(created)).toEqual({
      channel: {
        id: "channel-1",
        name: "Assistant channel",
        agentIds: ["agent-1"],
        threadId: "thread-1",
        active: true,
      },
    });
    expect(fetched.status).toBe(200);
    expect(await json(fetched)).toEqual({ channel: channel() });
  });

  test.each([
    ["{", "Channel input must be a JSON object."],
    [JSON.stringify([]), "Channel input must be a JSON object."],
    [JSON.stringify({ agentIds: [] }), "Agent IDs must be a non-empty array."],
  ])(
    "returns safe validation errors for malformed POST bodies",
    async (body, error) => {
      const store = fakeStore();
      const response = await appFor(store).request("http://openbot.test/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });

      expect(response.status).toBe(400);
      expect(await json(response)).toEqual({ error });
      expect(store.calls).toEqual([]);
    },
  );

  test("returns 404 when get returns null", async () => {
    const store = fakeStore({ get: async () => null });

    const response = await appFor(store).request("http://openbot.test/missing");

    expect(response.status).toBe(404);
    expect(await json(response)).toEqual({ error: "Channel not found." });
  });

  test.each([
    ["create", new AgentNotFoundError("agent-1"), 404, "Agent not found."],
    ["get", new ChannelNotFoundError("channel-1"), 404, "Channel not found."],
  ] as const)(
    "maps known store errors from %s",
    async (method, error, status, message) => {
      const store = fakeStore({
        ...(method === "create"
          ? {
              create: async () => {
                throw error;
              },
            }
          : {
              get: async () => {
                throw error;
              },
            }),
      });
      const app = appFor(store);
      const response =
        method === "create"
          ? await app.request("http://openbot.test/", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ agentIds: ["agent-1"] }),
            })
          : await app.request("http://openbot.test/channel-1");

      expect(response.status).toBe(status);
      expect(await json(response)).toEqual({ error: message });
    },
  );

  test("rethrows unexpected errors to the outer Hono error handler", async () => {
    const store = fakeStore({
      create: async () => {
        throw new Error("database disconnected");
      },
    });
    const app = appFor(store);
    app.onError((error, context) =>
      context.json({ sentinel: error.message }, 599),
    );

    const response = await app.request("http://openbot.test/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agentIds: ["agent-1"] }),
    });

    expect(response.status).toBe(599);
    expect(await json(response)).toEqual({ sentinel: "database disconnected" });
  });

  test("pins through the authenticated actor and reports the new state", async () => {
    const store = fakeStore();
    const app = appFor(store);

    const response = await app.request("http://openbot.test/channel-1/pin", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pinned: true }),
    });

    expect(response.status).toBe(200);
    expect(await json(response)).toEqual({ pinned: true });
    expect(store.calls).toEqual([["setPinned", actor, "channel-1", true]]);
  });

  test.each([
    ["{", "Pin input must be a JSON object."],
    [JSON.stringify([]), "Pin input must be a JSON object."],
    [JSON.stringify({}), "Pinned must be true or false."],
    [JSON.stringify({ pinned: "yes" }), "Pinned must be true or false."],
  ])("rejects malformed pin bodies: %p", async (body, error) => {
    const store = fakeStore();
    const response = await appFor(store).request(
      "http://openbot.test/channel-1/pin",
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body,
      },
    );

    expect(response.status).toBe(400);
    expect(await json(response)).toEqual({ error });
    expect(store.calls).toEqual([]);
  });

  test("keeps authentication in front of pinning", async () => {
    const store = fakeStore();
    const denied: MiddlewareHandler<{ Variables: AppVariables }> = (context) =>
      Promise.resolve(context.json({ error: "denied" }, 401));
    const app = appFor(store, denied);

    const response = await app.request("http://openbot.test/channel-1/pin", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pinned: true }),
    });

    expect(response.status).toBe(401);
    expect(store.calls).toEqual([]);
  });

  test("marks read through the authenticated actor and answers 204", async () => {
    const store = fakeStore();
    const response = await appFor(store).request(
      "http://openbot.test/channel-1/read",
      { method: "PUT" },
    );

    expect(response.status).toBe(204);
    expect(store.calls).toEqual([["markRead", actor, "channel-1"]]);
  });

  test("maps an unknown channel to 404 for marking read", async () => {
    const store = fakeStore({
      markRead: async () => {
        throw new ChannelNotFoundError("channel-1");
      },
    });
    const response = await appFor(store).request(
      "http://openbot.test/channel-1/read",
      { method: "PUT" },
    );

    expect(response.status).toBe(404);
    expect(await json(response)).toEqual({ error: "Channel not found." });
  });

  test("keeps authentication in front of marking read", async () => {
    const store = fakeStore();
    const denied: MiddlewareHandler<{ Variables: AppVariables }> = (context) =>
      Promise.resolve(context.json({ error: "denied" }, 401));
    const response = await appFor(store, denied).request(
      "http://openbot.test/channel-1/read",
      { method: "PUT" },
    );

    expect(response.status).toBe(401);
    expect(store.calls).toEqual([]);
  });

  test("deletes through the authenticated actor and answers 204", async () => {
    const store = fakeStore();
    const response = await appFor(store).request(
      "http://openbot.test/channel-1",
      { method: "DELETE" },
    );

    expect(response.status).toBe(204);
    expect(store.calls).toEqual([["softDelete", actor, "channel-1"]]);
  });

  test("maps a package-owned refusal to 409", async () => {
    const store = fakeStore({
      softDelete: async () => {
        throw new ChannelPackageOwnedError("channel-1");
      },
    });
    const response = await appFor(store).request(
      "http://openbot.test/channel-1",
      { method: "DELETE" },
    );

    expect(response.status).toBe(409);
    expect(await json(response)).toEqual({
      error:
        "This channel is defined by the deployment package, so it cannot be deleted here.",
    });
  });

  test("keeps authentication in front of deleting", async () => {
    const store = fakeStore();
    const denied: MiddlewareHandler<{ Variables: AppVariables }> = (context) =>
      Promise.resolve(context.json({ error: "denied" }, 401));
    const app = appFor(store, denied);

    const response = await app.request("http://openbot.test/channel-1", {
      method: "DELETE",
    });

    expect(response.status).toBe(401);
    expect(store.calls).toEqual([]);
  });
});

/**
 * The channel row survives a soft delete, but nothing on it says who hid it or when.
 *
 * "Where did that conversation go" is the question this answers, and the row is the only thing that
 * can: `deleted_at` is a timestamp with no actor. Untested, it is also the easiest thing to drop in
 * a later refactor without anything going red — which is exactly how it was lost once already.
 */
describe("channel delete audit", () => {
  /** Rows written by the route under test, in order. */
  let audited: AuditEventInput[] = [];

  beforeEach(() => {
    audited = [];
  });

  function appWithAudit(
    store: ChannelStore,
    auditStore: AuditStore = {
      insert: async (event) => void audited.push(event),
    },
  ) {
    const app = new Hono<{ Variables: AppVariables }>();
    app.route(
      "/",
      createChannelRoutes(store, requireUser, undefined, auditStore),
    );
    return app;
  }

  test("writes an attributed row naming the mechanism", async () => {
    const response = await appWithAudit(fakeStore()).request(
      "http://openbot.test/channel-1",
      { method: "DELETE" },
    );

    expect(response.status).toBe(204);
    expect(audited).toEqual([
      {
        eventType: "channel.deleted",
        targetType: "channel",
        targetId: "channel-1",
        actorUserId: actor.id,
        payload: { mechanism: "soft" },
      },
    ]);
  });

  /* Same discipline as bot-lifecycle-audit.test.ts: the trail records acts, not attempts. */
  test("a refused change writes nothing", async () => {
    const store = fakeStore({
      softDelete: async () => {
        throw new ChannelPackageOwnedError("channel-1");
      },
    });

    const response = await appWithAudit(store).request(
      "http://openbot.test/channel-1",
      { method: "DELETE" },
    );

    expect(response.status).toBe(409);
    expect(audited).toEqual([]);
  });

  test("a delete of somebody else's channel writes nothing", async () => {
    const store = fakeStore({
      softDelete: async () => {
        throw new ChannelNotFoundError("channel-1");
      },
    });

    const response = await appWithAudit(store).request(
      "http://openbot.test/channel-1",
      { method: "DELETE" },
    );

    expect(response.status).toBe(404);
    expect(audited).toEqual([]);
  });

  /*
   * Single-user is the mode `.env.example` ships switched on, so this is the row a fork sees by
   * default. The other audited surfaces drop the id here, believing `audit_events.actor_user_id`
   * has a foreign key into `users`; it has none, and `initializeDevActorUser` writes that row at
   * start-up regardless. An unattributed row would answer "was this conversation deleted" and not
   * "by whom", which is the half worth keeping.
   */
  test("attributes the local development actor rather than dropping it", async () => {
    const app = new Hono<{ Variables: AppVariables }>();
    app.route(
      "/",
      createChannelRoutes(
        fakeStore(),
        async (context, next) => {
          context.set("actor", DEV_ACTOR);
          await next();
        },
        undefined,
        { insert: async (event) => void audited.push(event) },
      ),
    );

    await app.request("http://openbot.test/channel-1", { method: "DELETE" });

    expect(audited[0]?.actorUserId).toBe(DEV_ACTOR.id);
  });

  /*
   * The channel is already hidden and the caller has already been told so by the time this runs. A
   * trail that is briefly unavailable is not a reason to report a failure that did not happen.
   */
  test("still answers when the audit write throws", async () => {
    const response = await appWithAudit(fakeStore(), {
      insert: async () => {
        throw new Error("audit table is unreachable");
      },
    }).request("http://openbot.test/channel-1", { method: "DELETE" });

    expect(response.status).toBe(204);
  });

  test("deletes without a trail when the deployment keeps none", async () => {
    const store = fakeStore();
    const app = new Hono<{ Variables: AppVariables }>();
    app.route("/", createChannelRoutes(store, requireUser));

    const response = await app.request("http://openbot.test/channel-1", {
      method: "DELETE",
    });

    expect(response.status).toBe(204);
    expect(store.calls).toEqual([["softDelete", actor, "channel-1"]]);
  });
});

describe("channel route composition", () => {
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
      // Positions 4-10, ending at agentProfileStore. `store` is position 11, channelStore. One
      // shorter than either side of the merge that produced this: see agent-routes.test.ts for why
      // a wrong count here fails silently rather than as a type error.
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      store,
    );

    const unauthenticated = await app.request(
      "http://openbot.test/api/channels/channel-1",
    );
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
    const authenticated = await app.request(
      "http://openbot.test/api/channels/channel-1",
    );

    expect(authenticated.status).toBe(200);
    expect(store.calls).toEqual([
      [
        "get",
        {
          ...actor,
          name: "OpenBot Member",
          image: "https://example.test/member.png",
        },
        "channel-1",
      ],
    ]);
  });

  test("leaves channel routes unmounted when createApp has no store", async () => {
    const app = createApp(loadConfig(testEnvironment()));

    const response = await app.request(
      "http://openbot.test/api/channels/channel-1",
    );

    expect(response.status).toBe(404);
  });
});

const databaseUrl =
  process.env.DATABASE_URL ??
  "postgres://openbot:openbot@localhost:5432/openbot";
const database = createDatabase(databaseUrl, TEST_POOL);
const profileStore = createAgentProfileStore(
  database,
  new URL("https://managed.example.test/ag-ui"),
);
const persistentStore = createChannelStore(
  database,
  profileStore,
  createThreadIdentity("test-deployment"),
);
const testPrefix = `channel-store-${randomUUID()}`;
const createdUserIds: string[] = [];
const createdAgentIds: string[] = [];
const createdChannelIds: string[] = [];
const createdPackageIds: string[] = [];

afterEach(async () => {
  for (const channelId of createdChannelIds.splice(0)) {
    await database
      .delete(intelligenceChannelMappings)
      .where(eq(intelligenceChannelMappings.channelId, channelId));
    await database.delete(channels).where(eq(channels.id, channelId));
  }
  for (const packageId of createdPackageIds.splice(0)) {
    await database
      .delete(deploymentPackages)
      .where(eq(deploymentPackages.id, packageId));
  }
  for (const agentId of createdAgentIds.splice(0)) {
    await database
      .delete(agentProfiles)
      .where(eq(agentProfiles.agentId, agentId));
    await database.delete(agents).where(eq(agents.id, agentId));
  }
  for (const userId of createdUserIds.splice(0)) {
    await database.delete(users).where(eq(users.id, userId));
  }
});

afterAll(async () => {
  await database.$client.close();
});

function persistentId(kind: string) {
  return `${testPrefix}-${kind}-${randomUUID()}`;
}

async function createPersistentUser(): Promise<AgentActor> {
  const userId = persistentId("user");
  await database.insert(users).values({
    id: userId,
    email: `${userId}@example.test`,
    name: "Channel Store Test User",
  });
  createdUserIds.push(userId);
  return { id: userId, role: "user" };
}

async function createPersistentAgent(options: {
  id?: string;
  name: string;
  owner: AgentActor;
  avatarImage?: string;
  visibility?: "public" | "private";
}) {
  const agentId = options.id ?? persistentId("agent");
  await database.insert(agents).values({
    id: agentId,
    name: options.name,
    type: "remote_ag_ui",
    configuration: { endpoint: "https://agent.example.test/ag-ui" },
  });
  createdAgentIds.push(agentId);
  await database.insert(agentProfiles).values({
    agentId,
    ownerUserId: options.owner.id,
    title: `${options.name} title`,
    roleDescription: `${options.name} role description`,
    avatarSeed: agentId,
    avatarImage: options.avatarImage,
    visibility: options.visibility ?? "private",
  });
  return agentId;
}

async function persistedChannel(channelId: string) {
  const [channelRow] = await database
    .select()
    .from(channels)
    .where(eq(channels.id, channelId));
  const memberships = await database
    .select()
    .from(channelMemberships)
    .where(eq(channelMemberships.channelId, channelId));
  const linkedAgents = await database
    .select()
    .from(channelAgents)
    .where(eq(channelAgents.channelId, channelId));
  const mappings = await database
    .select()
    .from(intelligenceChannelMappings)
    .where(eq(intelligenceChannelMappings.channelId, channelId));
  return { channelRow, memberships, linkedAgents, mappings };
}

async function channelTableSnapshot() {
  return {
    channels: (await database.select({ id: channels.id }).from(channels))
      .map(({ id }) => id)
      .sort(),
    memberships: (
      await database
        .select({
          channelId: channelMemberships.channelId,
          userId: channelMemberships.userId,
        })
        .from(channelMemberships)
    )
      .map(({ channelId, userId }) => `${channelId}:${userId}`)
      .sort(),
    agents: (
      await database
        .select({
          agentId: channelAgents.agentId,
          channelId: channelAgents.channelId,
        })
        .from(channelAgents)
    )
      .map(({ agentId, channelId }) => `${channelId}:${agentId}`)
      .sort(),
    mappings: (
      await database
        .select({
          channelId: intelligenceChannelMappings.channelId,
          threadId: intelligenceChannelMappings.threadId,
          userId: intelligenceChannelMappings.userId,
        })
        .from(intelligenceChannelMappings)
    )
      .map(
        ({ channelId, threadId, userId }) =>
          `${channelId}:${threadId}:${userId}`,
      )
      .sort(),
  };
}

describe("channel store integration", () => {
  test("carries uploaded coworker avatars into the roster summary", async () => {
    const actor = await createPersistentUser();
    const avatarImage = "data:image/png;base64,roster";
    const agentId = await createPersistentAgent({
      avatarImage,
      name: "Branded agent",
      owner: actor,
    });
    const created = await persistentStore.create(actor, [agentId]);
    createdChannelIds.push(created.id);

    const page = await persistentStore.list(actor);
    expect(page.channels.find((channel) => channel.id === created.id)).toEqual(
      expect.objectContaining({
        agentIds: [agentId],
        hasCustomAvatars: [true],
      }),
    );

    const persistentRequireUser: MiddlewareHandler<{
      Variables: AppVariables;
    }> = async (context, next) => {
      context.set("actor", actor);
      await next();
    };
    const response = await appFor(
      persistentStore,
      persistentRequireUser,
    ).request("http://openbot.test/");
    const body = (await response.json()) as {
      channels: { id: string; avatarUrls: (string | null)[] }[];
    };
    expect(
      body.channels.find((channel) => channel.id === created.id)?.avatarUrls,
    ).toEqual([
      expect.stringMatching(
        new RegExp(
          `^/api/agents/${agentId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/avatar/image\\?v=[a-z0-9]+$`,
        ),
      ),
    ]);
  });

  test("reads the creator's persisted channel exactly", async () => {
    const actor = await createPersistentUser();
    const agentId = await createPersistentAgent({
      name: "Historical agent",
      owner: actor,
    });
    const created = await persistentStore.create(actor, [agentId]);
    createdChannelIds.push(created.id);

    expect(await persistentStore.get(actor, created.id)).toEqual(created);
  });

  test("does not expose a member's channel to another user through public agents", async () => {
    const creator = await createPersistentUser();
    const otherUser = await createPersistentUser();
    const agentId = await createPersistentAgent({
      name: "Public historical agent",
      owner: creator,
      visibility: "public",
    });
    const created = await persistentStore.create(creator, [agentId]);
    createdChannelIds.push(created.id);
    const otherUserMiddleware: MiddlewareHandler<{
      Variables: AppVariables;
    }> = async (context, next) => {
      context.set("actor", otherUser);
      await next();
    };

    expect(await persistentStore.get(otherUser, created.id)).toBeNull();
    const response = await appFor(persistentStore, otherUserMiddleware).request(
      `http://openbot.test/${created.id}`,
    );
    expect(response.status).toBe(404);
    expect(await json(response)).toEqual({ error: "Channel not found." });
  });

  test("reads linked agent IDs in lexicographic order", async () => {
    const actor = await createPersistentUser();
    const agentIdBase = persistentId("ordered-agent");
    const laterAgentId = await createPersistentAgent({
      id: `${agentIdBase}-zulu`,
      name: "Zulu",
      owner: actor,
    });
    const earlierAgentId = await createPersistentAgent({
      id: `${agentIdBase}-alpha`,
      name: "Alpha",
      owner: actor,
    });
    const created = await persistentStore.create(actor, [
      laterAgentId,
      earlierAgentId,
    ]);
    createdChannelIds.push(created.id);

    expect((await persistentStore.get(actor, created.id))?.agentIds).toEqual(
      [earlierAgentId, laterAgentId].sort(),
    );
  });

  test("keeps a historical channel readable but inactive after a linked profile is deleted", async () => {
    const actor = await createPersistentUser();
    const activeAgentId = await createPersistentAgent({
      name: "Active historical agent",
      owner: actor,
    });
    const deletedAgentId = await createPersistentAgent({
      name: "Deleted historical agent",
      owner: actor,
    });
    const created = await persistentStore.create(
      actor,
      [activeAgentId, deletedAgentId].sort(),
    );
    createdChannelIds.push(created.id);
    await profileStore.softDelete(actor, deletedAgentId);

    expect(await persistentStore.get(actor, created.id)).toEqual({
      ...created,
      active: false,
    });
  });

  test("returns null when the member's channel mapping is missing", async () => {
    const actor = await createPersistentUser();
    const agentId = await createPersistentAgent({
      name: "Unmapped historical agent",
      owner: actor,
    });
    const created = await persistentStore.create(actor, [agentId]);
    createdChannelIds.push(created.id);
    await database
      .delete(intelligenceChannelMappings)
      .where(eq(intelligenceChannelMappings.channelId, created.id));

    expect(await persistentStore.get(actor, created.id)).toBeNull();
  });

  test("creates independent persisted channels for repeated agent selections", async () => {
    const actor = await createPersistentUser();
    const agentId = await createPersistentAgent({
      name: "Solo Agent",
      owner: actor,
    });

    const first = await persistentStore.create(actor, [agentId]);
    createdChannelIds.push(first.id);
    const second = await persistentStore.create(actor, [agentId]);
    createdChannelIds.push(second.id);

    expect(first).toMatchObject({
      name: "Solo Agent",
      agentIds: [agentId],
      active: true,
    });
    expect(second).toMatchObject({
      name: "Solo Agent",
      agentIds: [agentId],
      active: true,
    });
    expect(first.id).toMatch(/^channel_[0-9a-f-]{36}$/);
    expect(second.id).toMatch(/^channel_[0-9a-f-]{36}$/);
    expect(first.id).not.toBe(second.id);
    expect(first.threadId).toMatch(/^[0-9a-f-]{36}$/);
    expect(second.threadId).toMatch(/^[0-9a-f-]{36}$/);
    expect(first.threadId).not.toBe(second.threadId);

    for (const created of [first, second]) {
      const persisted = await persistedChannel(created.id);
      expect(persisted.channelRow).toMatchObject({
        id: created.id,
        name: "Solo Agent",
        description: "Private agent channel.",
        suggestedPrompts: [],
        allowedGroups: [],
        packageId: null,
        override: null,
      });
      expect(persisted.memberships).toHaveLength(1);
      expect(persisted.memberships[0]).toMatchObject({
        channelId: created.id,
        userId: actor.id,
      });
      expect(persisted.linkedAgents).toHaveLength(1);
      expect(persisted.linkedAgents[0]).toMatchObject({
        channelId: created.id,
        agentId,
      });
      expect(persisted.mappings).toHaveLength(1);
      expect(persisted.mappings[0]).toMatchObject({
        userId: actor.id,
        channelId: created.id,
        threadId: created.threadId,
      });
    }
  });

  test("persists every canonical agent and derives its name in canonical order", async () => {
    const actor = await createPersistentUser();
    const firstId = await createPersistentAgent({
      id: persistentId("agent-a"),
      name: "Zulu",
      owner: actor,
    });
    const secondId = await createPersistentAgent({
      id: persistentId("agent-b"),
      name: "Alpha",
      owner: actor,
    });
    const canonicalAgentIds = [firstId, secondId].sort();

    const created = await persistentStore.create(actor, canonicalAgentIds);
    createdChannelIds.push(created.id);

    expect(created).toEqual({
      id: created.id,
      name: "Zulu, Alpha",
      agentIds: canonicalAgentIds,
      threadId: created.threadId,
      active: true,
    });
    const persisted = await persistedChannel(created.id);
    expect(persisted.channelRow?.name).toBe("Zulu, Alpha");
    expect(persisted.linkedAgents.map(({ agentId }) => agentId).sort()).toEqual(
      canonicalAgentIds,
    );
  });

  test("truncates derived names to 120 Unicode code points with an ellipsis", async () => {
    const actor = await createPersistentUser();
    const longName = "😀".repeat(121);
    const agentId = await createPersistentAgent({
      name: longName,
      owner: actor,
    });

    const created = await persistentStore.create(actor, [agentId]);
    createdChannelIds.push(created.id);

    expect(Array.from(created.name)).toHaveLength(120);
    expect(created.name).toBe(`${"😀".repeat(119)}…`);
    expect((await persistedChannel(created.id)).channelRow?.name).toBe(
      created.name,
    );
  });

  test.each(["inaccessible private", "soft-deleted"] as const)(
    "rejects an %s agent and leaves every channel table unchanged",
    async (scenario) => {
      const actor = await createPersistentUser();
      const owner =
        scenario === "inaccessible private"
          ? await createPersistentUser()
          : actor;
      const accessibleAgentId = await createPersistentAgent({
        name: "Accessible agent",
        owner: actor,
      });
      const agentId = await createPersistentAgent({
        name: `${scenario} agent`,
        owner,
      });
      if (scenario === "soft-deleted") {
        await profileStore.softDelete(actor, agentId);
      }
      const before = await channelTableSnapshot();

      await expect(
        persistentStore.create(actor, [accessibleAgentId, agentId].sort()),
      ).rejects.toBeInstanceOf(AgentNotFoundError);

      expect(await channelTableSnapshot()).toEqual(before);
    },
  );
});

describe("channel pinning", () => {
  test("stamps and clears pinned_at on the caller's own membership", async () => {
    const actor = await createPersistentUser();
    const agentId = await createPersistentAgent({
      name: "Pinnable agent",
      owner: actor,
    });
    const created = await persistentStore.create(actor, [agentId]);
    createdChannelIds.push(created.id);

    await persistentStore.setPinned(actor, created.id, true);
    let [row] = await database
      .select({ pinnedAt: channelMemberships.pinnedAt })
      .from(channelMemberships)
      .where(
        and(
          eq(channelMemberships.channelId, created.id),
          eq(channelMemberships.userId, actor.id),
        ),
      );
    expect(row?.pinnedAt).not.toBeNull();

    await persistentStore.setPinned(actor, created.id, false);
    [row] = await database
      .select({ pinnedAt: channelMemberships.pinnedAt })
      .from(channelMemberships)
      .where(
        and(
          eq(channelMemberships.channelId, created.id),
          eq(channelMemberships.userId, actor.id),
        ),
      );
    expect(row?.pinnedAt).toBeNull();
  });

  test("refuses to pin a channel the caller is not a member of", async () => {
    const member = await createPersistentUser();
    const outsider = await createPersistentUser();
    const agentId = await createPersistentAgent({
      name: "Members-only agent",
      owner: member,
    });
    const created = await persistentStore.create(member, [agentId]);
    createdChannelIds.push(created.id);

    await expect(
      persistentStore.setPinned(outsider, created.id, true),
    ).rejects.toBeInstanceOf(ChannelNotFoundError);
  });

  test("pins and unpins through the caller's own membership", async () => {
    const actor = await createPersistentUser();
    const agentId = await createPersistentAgent({
      name: "Pinnable agent",
      owner: actor,
    });
    const created = await persistentStore.create(actor, [agentId]);
    createdChannelIds.push(created.id);

    await persistentStore.setPinned(actor, created.id, true);
    let page = await persistentStore.list(actor);
    expect(
      page.channels.find((channel) => channel.id === created.id)?.pinned,
    ).toBe(true);

    await persistentStore.setPinned(actor, created.id, false);
    page = await persistentStore.list(actor);
    expect(
      page.channels.find((channel) => channel.id === created.id)?.pinned,
    ).toBe(false);
  });

  test("one member's pin is invisible to another member", async () => {
    const pinner = await createPersistentUser();
    const other = await createPersistentUser();
    const agentId = await createPersistentAgent({
      name: "Shared pinnable agent",
      owner: pinner,
      visibility: "public",
    });
    const created = await persistentStore.create(pinner, [agentId]);
    createdChannelIds.push(created.id);
    // The store only creates the creator's membership; give the other user one directly,
    // plus the thread mapping the list join requires.
    await database.insert(channelMemberships).values({
      channelId: created.id,
      userId: other.id,
    });
    await database.insert(intelligenceChannelMappings).values({
      userId: other.id,
      channelId: created.id,
      // thread_id is globally unique; the pinner's own mapping row already claimed
      // created.threadId, so the other member's row needs one of its own.
      threadId: randomUUID(),
    });

    await persistentStore.setPinned(pinner, created.id, true);

    const otherPage = await persistentStore.list(other);
    expect(
      otherPage.channels.find((channel) => channel.id === created.id)?.pinned,
    ).toBe(false);
  });

  test("reports pinned false for a channel nobody pinned", async () => {
    const actor = await createPersistentUser();
    const agentId = await createPersistentAgent({
      name: "Unpinned agent",
      owner: actor,
    });
    const created = await persistentStore.create(actor, [agentId]);
    createdChannelIds.push(created.id);

    expect(
      (await persistentStore.list(actor)).channels.find(
        (channel) => channel.id === created.id,
      )?.pinned,
    ).toBe(false);
  });
});

describe("channel read markers", () => {
  // Two members of one channel, which is what a per-member marker has to be tested against.
  async function sharedChannel() {
    const reader = await createPersistentUser();
    const other = await createPersistentUser();
    const agentId = await createPersistentAgent({
      name: "Shared readable agent",
      owner: reader,
      visibility: "public",
    });
    const created = await persistentStore.create(reader, [agentId]);
    createdChannelIds.push(created.id);
    // The store only creates the creator's membership; give the other user one directly,
    // plus the thread mapping the list join requires.
    await database.insert(channelMemberships).values({
      channelId: created.id,
      userId: other.id,
    });
    await database.insert(intelligenceChannelMappings).values({
      userId: other.id,
      channelId: created.id,
      // thread_id is globally unique; the reader's own mapping row already claimed
      // created.threadId, so the other member's row needs one of its own.
      threadId: randomUUID(),
    });
    return { reader, other, channelId: created.id };
  }

  test("stamps last_read_at on the caller's own membership only", async () => {
    const { reader, other, channelId } = await sharedChannel();

    await persistentStore.markRead(reader, channelId);

    const rows = await database
      .select({
        userId: channelMemberships.userId,
        lastReadAt: channelMemberships.lastReadAt,
      })
      .from(channelMemberships)
      .where(eq(channelMemberships.channelId, channelId));
    expect(
      rows.find((row) => row.userId === reader.id)?.lastReadAt,
    ).not.toBeNull();
    expect(rows.find((row) => row.userId === other.id)?.lastReadAt).toBeNull();
  });

  test("the list carries the caller's lastReadAt and nobody else's", async () => {
    const { reader, other, channelId } = await sharedChannel();

    await persistentStore.markRead(reader, channelId);

    const forReader = await persistentStore.list(reader);
    const forOther = await persistentStore.list(other);
    expect(
      forReader.channels.find((channel) => channel.id === channelId)
        ?.lastReadAt,
    ).not.toBeNull();
    expect(
      forOther.channels.find((channel) => channel.id === channelId)?.lastReadAt,
    ).toBeNull();
  });

  test("refuses to mark read a channel the caller is not a member of", async () => {
    const { channelId } = await sharedChannel();
    const outsider = await createPersistentUser();

    await expect(
      persistentStore.markRead(outsider, channelId),
    ).rejects.toBeInstanceOf(ChannelNotFoundError);
  });

  test("stamps a read no earlier than the channel's own last-message clock", async () => {
    const { reader, channelId } = await sharedChannel();
    // last_message_at is written from the reporting browser's clock and is not bounded; simulate
    // one running ahead of the server so a plain "now" stamp would still read as unseen.
    const future = new Date(Date.now() + 60_000);
    await database
      .update(channels)
      .set({ lastMessageAt: future })
      .where(eq(channels.id, channelId));

    await persistentStore.markRead(reader, channelId);

    const [row] = await database
      .select({ lastReadAt: channelMemberships.lastReadAt })
      .from(channelMemberships)
      .where(
        and(
          eq(channelMemberships.channelId, channelId),
          eq(channelMemberships.userId, reader.id),
        ),
      );
    expect(row?.lastReadAt).not.toBeNull();
    expect(row?.lastReadAt?.getTime() ?? 0).toBeGreaterThanOrEqual(
      future.getTime(),
    );
  });

  test("refuses to mark a soft-deleted channel read, mirroring setPinned", async () => {
    const { reader, channelId } = await sharedChannel();

    await persistentStore.softDelete(reader, channelId);

    await expect(
      persistentStore.markRead(reader, channelId),
    ).rejects.toBeInstanceOf(ChannelNotFoundError);

    const [row] = await database
      .select({ lastReadAt: channelMemberships.lastReadAt })
      .from(channelMemberships)
      .where(
        and(
          eq(channelMemberships.channelId, channelId),
          eq(channelMemberships.userId, reader.id),
        ),
      );
    // The membership row outlives the channel, but its marker was never stamped.
    expect(row?.lastReadAt).toBeNull();
  });
});

describe("channel soft delete", () => {
  test("hides a deleted channel from list and get", async () => {
    const actor = await createPersistentUser();
    const other = await createPersistentUser();
    const agentId = await createPersistentAgent({
      name: "Deletable agent",
      owner: actor,
      visibility: "public",
    });
    const created = await persistentStore.create(actor, [agentId]);
    createdChannelIds.push(created.id);
    // The store only creates the creator's membership; give the other user one directly,
    // plus the thread mapping the list join requires.
    await database.insert(channelMemberships).values({
      channelId: created.id,
      userId: other.id,
    });
    await database.insert(intelligenceChannelMappings).values({
      userId: other.id,
      channelId: created.id,
      // thread_id is globally unique; the actor's own mapping row already claimed
      // created.threadId, so the other member's row needs one of its own.
      threadId: randomUUID(),
    });

    await persistentStore.softDelete(actor, created.id);

    expect(await persistentStore.get(actor, created.id)).toBeNull();
    const page = await persistentStore.list(actor);
    expect(
      page.channels.find((channel) => channel.id === created.id),
    ).toBeUndefined();

    expect(await persistentStore.get(other, created.id)).toBeNull();
    const otherPage = await persistentStore.list(other);
    expect(
      otherPage.channels.find((channel) => channel.id === created.id),
    ).toBeUndefined();
  });

  test("stamps deleted_at on the channel", async () => {
    const actor = await createPersistentUser();
    const agentId = await createPersistentAgent({
      name: "Deletable agent",
      owner: actor,
    });
    const created = await persistentStore.create(actor, [agentId]);
    createdChannelIds.push(created.id);

    await persistentStore.softDelete(actor, created.id);

    // Soft: the row is still there, stamped rather than gone.
    const [row] = await database
      .select({ deletedAt: channels.deletedAt })
      .from(channels)
      .where(eq(channels.id, created.id));
    expect(row?.deletedAt).not.toBeNull();
  });

  test("deleting again is a no-op, not an error", async () => {
    const actor = await createPersistentUser();
    const agentId = await createPersistentAgent({
      name: "Twice-deleted agent",
      owner: actor,
    });
    const created = await persistentStore.create(actor, [agentId]);
    createdChannelIds.push(created.id);

    await persistentStore.softDelete(actor, created.id);
    await expect(
      persistentStore.softDelete(actor, created.id),
    ).resolves.toBeUndefined();
  });

  test("refuses to delete a channel the caller is not a member of", async () => {
    const member = await createPersistentUser();
    const outsider = await createPersistentUser();
    const agentId = await createPersistentAgent({
      name: "Guarded agent",
      owner: member,
    });
    const created = await persistentStore.create(member, [agentId]);
    createdChannelIds.push(created.id);

    await expect(
      persistentStore.softDelete(outsider, created.id),
    ).rejects.toBeInstanceOf(ChannelNotFoundError);
  });

  /*
   * A deleted channel is gone as far as every other path is concerned.
   *
   * `get` and `list` filter on `deleted_at`, so a member who still has a stale roster row, or a
   * client that reports the reply to a message sent moments before the delete, would otherwise be
   * writing to and announcing a channel nobody can see: every member's browser refetches its roster
   * for a row that resolves to nothing.
   */
  test("refuses activity on a deleted channel and leaves the last message alone", async () => {
    const actor = await createPersistentUser();
    const agentId = await createPersistentAgent({
      name: "Silenced agent",
      owner: actor,
    });
    const created = await persistentStore.create(actor, [agentId]);
    createdChannelIds.push(created.id);
    await persistentStore.recordActivity(actor, created.id, {
      agentId,
      at: new Date(Date.now() - 60_000),
      text: "Said before the delete.",
    });
    await persistentStore.softDelete(actor, created.id);

    await expect(
      persistentStore.recordActivity(actor, created.id, {
        agentId,
        at: new Date(),
        text: "Said after the delete.",
      }),
    ).rejects.toBeInstanceOf(ChannelNotFoundError);

    // Same answer `get` gives, and the row the roster would have shown is untouched.
    const [row] = await database
      .select({
        lastMessage: channels.lastMessage,
        lastMessageAt: channels.lastMessageAt,
      })
      .from(channels)
      .where(eq(channels.id, created.id));
    expect(row?.lastMessage).toBe("Said before the delete.");
  });

  test("refuses to pin a deleted channel and leaves the membership alone", async () => {
    const actor = await createPersistentUser();
    const agentId = await createPersistentAgent({
      name: "Unpinnable agent",
      owner: actor,
    });
    const created = await persistentStore.create(actor, [agentId]);
    createdChannelIds.push(created.id);
    await persistentStore.softDelete(actor, created.id);

    await expect(
      persistentStore.setPinned(actor, created.id, true),
    ).rejects.toBeInstanceOf(ChannelNotFoundError);

    const [row] = await database
      .select({ pinnedAt: channelMemberships.pinnedAt })
      .from(channelMemberships)
      .where(
        and(
          eq(channelMemberships.channelId, created.id),
          eq(channelMemberships.userId, actor.id),
        ),
      );
    expect(row?.pinnedAt).toBeNull();
  });

  test("refuses to delete a package-defined channel", async () => {
    const actor = await createPersistentUser();
    const [pkg] = await database
      .insert(deploymentPackages)
      .values({
        tenantId: persistentId("tenant"),
        sourcePath: "/tmp/none",
        checksum: "0",
      })
      .returning({ id: deploymentPackages.id });
    if (!pkg) throw new Error("package row was not created");
    createdPackageIds.push(pkg.id);
    const channelId = persistentId("package-channel");
    await database.insert(channels).values({
      id: channelId,
      name: "Package channel",
      description: "Defined by the tenant package.",
      packageId: pkg.id,
    });
    createdChannelIds.push(channelId);
    await database.insert(channelMemberships).values({
      channelId,
      userId: actor.id,
    });

    await expect(
      persistentStore.softDelete(actor, channelId),
    ).rejects.toBeInstanceOf(ChannelPackageOwnedError);
  });
});

/**
 * Channel creation validates each selected agent through the profile store while its own
 * transaction is open. If that read runs on a second pooled connection it is both a deadlock (the
 * transaction holds a connection while waiting for one) and a time-of-check race (the read sees a
 * different snapshot and takes no lock, so a concurrent deletion lands between check and insert).
 */
describe("channel store concurrency", () => {
  test("creates a channel without borrowing a second connection", async () => {
    const singleConnection = createDatabase(databaseUrl, { max: 1 });
    const store = createChannelStore(
      singleConnection,
      createAgentProfileStore(
        singleConnection,
        new URL("https://managed.example.test/ag-ui"),
      ),
      createThreadIdentity("test-deployment"),
    );
    const owner = await createPersistentUser();
    const agentId = await createPersistentAgent({
      name: "Single connection agent",
      owner,
    });

    try {
      const created = await store.create(owner, [agentId]);
      createdChannelIds.push(created.id);

      expect(created.agentIds).toEqual([agentId]);
    } finally {
      await singleConnection.$client.close();
    }
  });

  test("refuses an agent whose deletion commits mid-creation", async () => {
    const owner = await createPersistentUser();
    const agentId = await createPersistentAgent({
      name: "Concurrently deleted agent",
      owner,
    });

    let markDeleted: () => void = () => {};
    let releaseDeletion: () => void = () => {};
    const deletionApplied = new Promise<void>((resolve) => {
      markDeleted = resolve;
    });
    const deletionHeld = new Promise<void>((resolve) => {
      releaseDeletion = resolve;
    });
    const deletion = database.transaction(async (transaction) => {
      await transaction
        .update(agentProfiles)
        .set({ deletedAt: new Date() })
        .where(eq(agentProfiles.agentId, agentId));
      markDeleted();
      await deletionHeld;
    });

    await deletionApplied;
    const creation = persistentStore.create(owner, [agentId]);
    // Long enough for a correct implementation to reach the row lock and block on it.
    await Bun.sleep(250);
    releaseDeletion();
    await deletion;

    const outcome = await creation.then(
      (created) => {
        createdChannelIds.push(created.id);
        return created;
      },
      (error: unknown) => error,
    );

    expect(outcome).toBeInstanceOf(AgentNotFoundError);
    expect(
      await database
        .select({ channelId: channelAgents.channelId })
        .from(channelAgents)
        .where(eq(channelAgents.agentId, agentId)),
    ).toEqual([]);
  });
});
