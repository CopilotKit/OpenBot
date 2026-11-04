import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
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
import { writeKey } from "../src/conversations/http";
import type { Conversation } from "../src/conversations/types";
import { createDatabase } from "../src/db/client";
import { users } from "../src/db/schema";
import {
  deleteBot,
  recordTestPackage,
  removeTestPackages,
  removeBots,
  seedBot,
  useTestBots,
} from "./support/bots";
import {
  addConversationMember,
  conversationClient,
  purgeConversations,
  seedConversation,
  storedConversation,
  useTestConversations,
} from "./support/conversations";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
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
    lastMessageAt: null,
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
    // A read beside the one the route was asked for, so it is not a call worth asserting on.
    async workIn() {
      return new Map();
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

/*
 * What a conversation is waiting on comes back with the read, so a reload shows it. It used to live
 * on the socket and nowhere else, and a refresh in the middle of a hop forgot it.
 */
describe("what a channel is waiting on", () => {
  const since = new Date("2026-10-26T09:00:00.000Z");
  const waiting = new Map([
    [
      "channel-1",
      [
        {
          kind: "handoff" as const,
          key: "hop-1",
          botId: "ana",
          botName: "Ana",
          since,
        },
      ],
    ],
  ]);

  test("the channel read carries the list", async () => {
    const store = fakeStore({ workIn: async () => waiting });

    const fetched = await appFor(store).request(
      "http://openbot.test/channel-1",
    );

    expect(await json(fetched)).toEqual({
      channel: {
        ...channel(),
        work: [
          {
            kind: "handoff",
            key: "hop-1",
            botId: "ana",
            botName: "Ana",
            since: since.toISOString(),
          },
        ],
      },
    });
  });

  test("the roster carries it too, and lights only the rows that have some", async () => {
    const summary = (id: string) => ({
      ...channel({ id }),
      summary: null,
      lastMessage: null,
      lastMessageAgentId: null,
      createdAt: since,
      pinned: false,
      lastReadAt: null,
      task: false,
    });
    const store = fakeStore({
      list: async () => ({
        channels: [summary("channel-1"), summary("channel-2")],
        nextCursor: null,
      }),
      workIn: async () => waiting,
    });

    const response = await appFor(store).request("http://openbot.test/");
    const body = (await response.json()) as {
      channels: Array<{ id: string; busy?: boolean; work: unknown[] }>;
    };

    expect(body.channels[0]).toMatchObject({ id: "channel-1", busy: true });
    expect(body.channels[0]?.work).toHaveLength(1);
    // Absent rather than false: a person's own run in another tab is not on any row this reads.
    expect(body.channels[1]).toBeDefined();
    expect(body.channels[1]).not.toHaveProperty("busy");
    expect(body.channels[1]?.work).toEqual([]);
  });

  test("the roster says which conversation is a task's own", async () => {
    const summary = (id: string, task: boolean) => ({
      ...channel({ id }),
      summary: null,
      lastMessage: null,
      lastMessageAgentId: null,
      createdAt: since,
      pinned: false,
      lastReadAt: null,
      task,
    });
    const store = fakeStore({
      list: async () => ({
        channels: [summary("own", false), summary("task", true)],
        nextCursor: null,
      }),
      workIn: async () => new Map(),
    });

    const response = await appFor(store).request("http://openbot.test/");
    const body = (await response.json()) as {
      channels: Array<{ id: string; task: boolean }>;
    };
    expect(body.channels.map(({ id, task }) => ({ id, task }))).toEqual([
      { id: "own", task: false },
      { id: "task", task: true },
    ]);
  });
});

describe("channel list limit", () => {
  /**
   * `?limit=` used to be read with `Number.parseInt`, which coerces: `"12abc"` arrived as 12
   * and `"3.9"` as 3, and every one of them answered 200 with a silently coerced page. A run of
   * digits is clamped into range like the store already does; anything else is a 400 naming the
   * parameter, before the store is reached.
   */
  function listApp(calls: { queries: unknown[] }) {
    const store = fakeStore({
      async list(_actor, query) {
        calls.queries.push(query);
        return { channels: [], nextCursor: null };
      },
    });
    return appFor(store);
  }

  test.each([["12abc"], ["3.9"], ["-5"], ["0x10"], ["%2B5"]])(
    "refuses a coerced limit %p with 400 and never reaches the store",
    async (limit) => {
      const calls = { queries: [] as unknown[] };
      const response = await listApp(calls).request(
        `http://openbot.test/?limit=${limit}`,
      );

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: 'Query parameter "limit" must be a positive integer.',
      });
      expect(calls.queries).toEqual([]);
    },
  );

  test.each([
    ["10", { limit: 10 }],
    ["999999", { limit: 200 }],
    ["0", { limit: 1 }],
  ])("passes a well-formed limit %p through as %p", async (limit, query) => {
    const calls = { queries: [] as unknown[] };
    const response = await listApp(calls).request(
      `http://openbot.test/?limit=${limit}`,
    );

    expect(response.status).toBe(200);
    expect(calls.queries).toEqual([query]);
  });

  test("leaves an absent limit to the store default", async () => {
    const calls = { queries: [] as unknown[] };
    const response = await listApp(calls).request("http://openbot.test/");

    expect(response.status).toBe(200);
    expect(calls.queries).toEqual([{}]);
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
        lastMessageAt: null,
      },
    });
    expect(fetched.status).toBe(200);
    expect(await json(fetched)).toEqual({
      channel: { ...channel(), work: [] },
    });
  });

  /**
   * The date leaves as a string, and it has to leave at all.
   *
   * This is what lets the conversation screen tell an empty NEW conversation from one whose history
   * this deployment cannot reach: null means nothing was ever said, a timestamp means something
   * was. Dropping it from the DTO would put the screen back to rendering a blank window with no
   * explanation for a conversation that plainly has a past.
   */
  test("carries when the channel was last spoken in, as a string", async () => {
    const spokenAt = new Date("2026-09-07T20:25:48.391Z");
    const store = fakeStore({
      async get() {
        return channel({ lastMessageAt: spokenAt });
      },
    });

    const fetched = await appFor(store).request(
      "http://openbot.test/channel-1",
    );

    expect(fetched.status).toBe(200);
    expect(await json(fetched)).toEqual({
      channel: {
        ...channel(),
        lastMessageAt: spokenAt.toISOString(),
        work: [],
      },
    });
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
    expect(await json(response)).toEqual({
      error: "Couldn't find that conversation.",
    });
  });

  test.each([
    [
      "create",
      new AgentNotFoundError("agent-1"),
      404,
      "Couldn't find that Bot.",
    ],
    [
      "get",
      new ChannelNotFoundError("channel-1"),
      404,
      "Couldn't find that conversation.",
    ],
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
    expect(await json(response)).toEqual({
      error: "Couldn't find that conversation.",
    });
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
      error: "This conversation is built in and can't be deleted.",
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

  test("a repeat delete answers 204 and writes no second row", async () => {
    // The store's answer for a channel that was already deleted: nothing changed.
    const response = await appWithAudit(
      fakeStore({ softDelete: async () => false }),
    ).request("http://openbot.test/channel-1", { method: "DELETE" });

    expect(response.status).toBe(204);
    expect(audited).toEqual([]);
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

const databaseUrl = testDatabaseUrl();
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

afterEach(async () => {
  await purgeConversations(createdChannelIds.splice(0));
  await removeBots(createdAgentIds.splice(0));
  for (const userId of createdUserIds.splice(0)) {
    await database.delete(users).where(eq(users.id, userId));
  }
});

beforeAll(async () => {
  await useTestBots();
});

afterAll(async () => {
  await removeTestPackages();
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
  visibility?: "public" | "private";
}) {
  const agentId = options.id ?? persistentId("agent");
  await seedBot({
    id: agentId,
    name: options.name,
    type: "remote_ag_ui",
    configuration: { endpoint: "https://agent.example.test/ag-ui" },
    ownerUserId: options.owner.id,
    title: `${options.name} title`,
    roleDescription: `${options.name} role description`,
    avatarSeed: agentId,
    visibility: options.visibility ?? "private",
  });
  createdAgentIds.push(agentId);
  return agentId;
}

/**
 * The channel as Intelligence holds it now, past this process's memory: the conversation header
 * (what the `channels` row held), its members, its Bots, and its thread pointers (a member's own
 * thread is what `intelligence_channel_mappings` held).
 */
async function persistedChannel(channelId: string) {
  const conversation = await storedConversation(channelId);
  return {
    channelRow: conversation,
    memberships: conversation.members,
    linkedAgents: conversation.agents,
    mappings: conversation.threads,
  };
}

/** One member's own state in a channel (pin, read marker) as Intelligence holds it now. */
async function membershipOf(channelId: string, userId: string) {
  return (await storedConversation(channelId)).members.find(
    (member) => member.userId === userId,
  );
}

/**
 * Everything a channel creation by these people with these Bots could have written, as Intelligence
 * holds it: every conversation, deleted ones included, that names one of the people as a member or
 * one of the Bots, with its members, Bots and thread pointers.
 *
 * Scoped to those people and Bots rather than the whole project, unlike the snapshot of every
 * channel table it replaces, because the test Intelligence is shared by every suite running at the
 * same time; a conversation another suite makes meanwhile is not a write this creation made.
 */
async function channelTableSnapshot(
  userIds: readonly string[],
  agentIds: readonly string[],
) {
  const client = await conversationClient();
  const found = new Map<string, Conversation>();
  for (const userId of userIds)
    for (const conversation of await client.all({
      memberUserId: userId,
      includeDeleted: true,
    }))
      found.set(conversation.id, conversation);
  for (const agentId of agentIds)
    for (const conversation of await client.all({
      agentId,
      includeDeleted: true,
    }))
      found.set(conversation.id, conversation);
  const all = [...found.values()];
  return {
    channels: all.map(({ id }) => id).sort(),
    memberships: all
      .flatMap(({ id, members }) =>
        members.map(({ userId }) => `${id}:${userId}`),
      )
      .sort(),
    agents: all
      .flatMap(({ id, agents }) =>
        agents.map(({ agentId }) => `${id}:${agentId}`),
      )
      .sort(),
    mappings: all
      .flatMap(({ id, threads }) =>
        threads.map(
          ({ threadId, userId, agentId }) =>
            `${id}:${threadId}:${userId}:${agentId ?? ""}`,
        ),
      )
      .sort(),
  };
}

describe("channel store integration", () => {
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
    expect(await json(response)).toEqual({
      error: "Couldn't find that conversation.",
    });
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
    /*
     * A thread pointer is never changed or removed on its own in Intelligence; removing a member
     * removes theirs, and adding them back without a thread leaves them a member with none. That is
     * the state the deleted mapping row used to stand for: a member of the channel with no thread of
     * their own in it. Kept in this process's directory, which `get` reads.
     */
    const { conversations } = await useTestConversations();
    conversations.apply(
      await conversations.client.removeMember(
        created.id,
        actor.id,
        writeKey("test.member.remove"),
      ),
    );
    const unmapped = conversations.apply(
      await conversations.client.addMember(
        created.id,
        actor.id,
        {},
        writeKey("test.member"),
      ),
    );
    expect(unmapped.members.map(({ userId }) => userId)).toEqual([actor.id]);
    expect(unmapped.threads).toEqual([]);

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
      // `managedBy` is what `package_id` was. The row's `override` column has no counterpart: nothing
      // ever wrote it, and a conversation has no such field.
      expect(persisted.channelRow).toMatchObject({
        id: created.id,
        name: "Solo Agent",
        description: "Private agent channel.",
        suggestedPrompts: [],
        allowedGroups: [],
        managedBy: null,
        taskId: null,
      });
      expect(persisted.memberships).toHaveLength(1);
      expect(persisted.memberships[0]).toMatchObject({
        userId: actor.id,
      });
      expect(persisted.linkedAgents).toHaveLength(1);
      expect(persisted.linkedAgents[0]).toMatchObject({
        agentId,
      });
      // Every thread pointer, not only own ones: a person's channel holds their own thread and no
      // Bot's thread, so exactly the one the mapping row held.
      expect(persisted.mappings).toHaveLength(1);
      expect(persisted.mappings[0]).toMatchObject({
        userId: actor.id,
        conversationId: created.id,
        agentId: null,
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
      lastMessageAt: null,
    });
    const persisted = await persistedChannel(created.id);
    expect(persisted.channelRow?.name).toBe("Zulu, Alpha");
    expect(persisted.linkedAgents.map(({ agentId }) => agentId).sort()).toEqual(
      canonicalAgentIds,
    );
  });

  test("truncates derived names to 120 Unicode code points with an ellipsis", async () => {
    const actor = await createPersistentUser();
    // Three Bots at the longest name a Bot may have (80 UTF-16 units, so 40 of these), which is how
    // a channel's name runs past 120: one Bot's name never can, and Intelligence refuses one that
    // long. Each emoji is two UTF-16 units and one code point, so a cut by length would differ.
    const longName = "😀".repeat(40);
    const agentIds: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      agentIds.push(
        await createPersistentAgent({ name: longName, owner: actor }),
      );
    }

    const created = await persistentStore.create(actor, agentIds);
    createdChannelIds.push(created.id);

    expect(Array.from(created.name)).toHaveLength(120);
    expect(created.name).toBe(`${longName}, ${longName}, ${"😀".repeat(35)}…`);
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
      const people = [actor.id, owner.id];
      const bots = [accessibleAgentId, agentId];
      const before = await channelTableSnapshot(people, bots);

      await expect(
        persistentStore.create(actor, [accessibleAgentId, agentId].sort()),
      ).rejects.toBeInstanceOf(AgentNotFoundError);

      expect(await channelTableSnapshot(people, bots)).toEqual(before);
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
    let row = await membershipOf(created.id, actor.id);
    expect(row?.pinnedAt).not.toBeNull();

    await persistentStore.setPinned(actor, created.id, false);
    row = await membershipOf(created.id, actor.id);
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
    // The store only makes the creator a member; add the other user directly, with the thread of
    // their own the list requires (thread ids are unique across the project, so a new one).
    await addConversationMember(created.id, other.id);

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
    // The store only makes the creator a member; add the other user directly, with the thread of
    // their own the list requires (thread ids are unique across the project, so a new one).
    await addConversationMember(created.id, other.id);
    return { reader, other, channelId: created.id };
  }

  test("stamps last_read_at on the caller's own membership only", async () => {
    const { reader, other, channelId } = await sharedChannel();

    await persistentStore.markRead(reader, channelId);

    const rows = (await storedConversation(channelId)).members;
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
    const { applied } = await (await conversationClient()).activity(
      channelId,
      {
        userId: reader.id,
        text: "Said by a clock running ahead.",
        at: future,
        agentId: null,
        sourceId: null,
        enrichFrom: null,
      },
      writeKey("test.activity"),
    );
    expect(applied).toBe(true);

    await persistentStore.markRead(reader, channelId);

    const row = await membershipOf(channelId, reader.id);
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

    const row = await membershipOf(channelId, reader.id);
    // The membership outlives the channel, but its marker was never stamped.
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
    // The store only makes the creator a member; add the other user directly, with the thread of
    // their own the list requires (thread ids are unique across the project, so a new one).
    await addConversationMember(created.id, other.id);

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

    // Soft: the conversation is still there, stamped rather than gone.
    const row = await storedConversation(created.id);
    expect(row.deletedAt).not.toBeNull();
  });

  test("deleting again is a no-op, not an error", async () => {
    const actor = await createPersistentUser();
    const agentId = await createPersistentAgent({
      name: "Twice-deleted agent",
      owner: actor,
    });
    const created = await persistentStore.create(actor, [agentId]);
    createdChannelIds.push(created.id);

    await expect(persistentStore.softDelete(actor, created.id)).resolves.toBe(
      true,
    );
    // Resolves rather than throws, and says it deleted nothing, so nothing is announced or recorded.
    await expect(persistentStore.softDelete(actor, created.id)).resolves.toBe(
      false,
    );
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
    const row = await storedConversation(created.id);
    expect(row.lastMessage).toBe("Said before the delete.");
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

    const row = await membershipOf(created.id, actor.id);
    expect(row).toBeDefined();
    expect(row?.pinnedAt).toBeNull();
  });

  test("refuses to delete a package-defined channel", async () => {
    const actor = await createPersistentUser();
    const pkg = await recordTestPackage(persistentId("tenant"));
    const channelId = persistentId("package-channel");
    createdChannelIds.push(channelId);
    // Owned by the package as tenant-package.ts marks one: `managedBy` names the package. A member
    // with no thread of their own, as the bare membership row was.
    await seedConversation({
      id: channelId,
      name: "Package channel",
      description: "Defined by the tenant package.",
      managedBy: pkg.id,
      members: [{ userId: actor.id, threadId: null }],
    });

    await expect(
      persistentStore.softDelete(actor, channelId),
    ).rejects.toBeInstanceOf(ChannelPackageOwnedError);
  });
});

/**
 * Channel creation validates each selected agent, reading the person's own rows from this database
 * and the Bot from this instance's memory, and then writes the conversation to Intelligence. It must
 * not need a second pooled connection while holding one, which would deadlock a one-connection pool,
 * and no transaction here may wait on Intelligence.
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

  /*
   * A Bot lives in Intelligence, so no row lock in this database can hold its deletion off until a
   * channel is written, and the check and the write cannot be made one. What has to hold instead is
   * that a Bot deleted after the check never leaves a live channel: the channel reads back inactive,
   * exactly as one whose Bot was deleted a moment after it was made.
   *
   * The channel is written to Intelligence now, with no transaction here for a lock to hold open, so
   * the creation is parked inside its check instead: after it has read the Bot as live, at its last
   * step, which reads this person's preferences for that Bot. This connection holds that table
   * exclusively, so the creation waits there; the Bot is deleted; and then the check finishes on the
   * Bot as it read it and the channel is written. A store of its own on one connection, so the wait
   * found below is this creation's and not another suite's on the same database.
   */
  test("a Bot deleted while its channel is being made leaves that channel inactive", async () => {
    const owner = await createPersistentUser();
    const agentId = await createPersistentAgent({
      name: "Concurrently deleted agent",
      owner,
    });

    const creating = createDatabase(databaseUrl, { max: 1 });
    const holder = createDatabase(databaseUrl, { max: 1 });
    let outcome: Promise<AgentChannel | unknown> = Promise.resolve();
    try {
      const store = createChannelStore(
        creating,
        createAgentProfileStore(
          creating,
          new URL("https://managed.example.test/ag-ui"),
        ),
        createThreadIdentity("test-deployment"),
      );
      const [session] = await creating.execute<{ pid: number }>(
        sql`select pg_backend_pid() as pid`,
      );
      if (!session) throw new Error("The creating connection has no session.");

      await holder.transaction(async (transaction) => {
        await transaction.execute(
          sql`lock table agent_preferences in access exclusive mode`,
        );
        outcome = store.create(owner, [agentId]).then(
          (created) => {
            createdChannelIds.push(created.id);
            return created;
          },
          (error: unknown) => error,
        );
        // Until the creation is waiting behind this connection's lock.
        for (let attempt = 0; ; attempt += 1) {
          const [row] = await transaction.execute<{ waiting: boolean }>(
            sql`select pg_backend_pid() = any(pg_blocking_pids(${session.pid}::int)) as waiting`,
          );
          if (row?.waiting) break;
          if (attempt === 500)
            throw new Error("The creation never reached the held lock.");
          await Bun.sleep(10);
        }
        await deleteBot(agentId);
      });
    } finally {
      await holder.$client.close();
      await outcome;
      await creating.$client.close();
    }

    const created = await outcome;
    if (created instanceof Error) throw created;
    const channel = created as AgentChannel;
    expect(channel.agentIds).toEqual([agentId]);
    expect(await persistentStore.get(owner, channel.id)).toEqual({
      ...channel,
      active: false,
    });
    const listed = (await persistentStore.list(owner)).channels.find(
      (entry) => entry.id === channel.id,
    );
    expect(listed?.active).toBe(false);
  });
});
