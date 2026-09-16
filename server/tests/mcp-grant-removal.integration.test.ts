import { afterAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { createAuditStore } from "../src/audit";
import { createDatabase } from "../src/db/client";
import { agents, mcpServers, mcpTools, pluginGrants } from "../src/db/schema";
import type { ComposioBroker } from "../src/plugins/broker";
import { useComposioClient } from "../src/plugins/composio";
import { createPluginStore } from "../src/plugins/store";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);

const suite = randomUUID().slice(0, 8);
const slug = `removed${suite}`;
const serverId = `composio-${slug}`;
const actionName = `${slug.toUpperCase()}_FETCH`;
const ref = `${serverId}/${actionName}`;
const keptSlug = `kept${suite}`;
const keptServerId = `composio-${keptSlug}`;
const keptAction = `${keptSlug.toUpperCase()}_FETCH`;
const keptRef = `${keptServerId}/${keptAction}`;
const botId = `agent_grant_removal_${suite}`;

const broker: ComposioBroker = {
  listApps: async () => [],
  ensureAuthConfig: async () => undefined,
  deleteAuthConfig: async () => undefined,
  authorize: async () => {
    throw new Error("the removal path asked the broker to begin a connection");
  },
  isConnected: async () => true,
  revoke: async () => true,
};

const events: { eventType: string; payload: Record<string, unknown> }[] = [];
const persisting = createAuditStore(database);
const auditStore = {
  insert: async (event: Parameters<typeof persisting.insert>[0]) => {
    events.push({
      eventType: event.eventType,
      payload: (event.payload ?? {}) as Record<string, unknown>,
    });
    await persisting.insert(event);
  },
};

const store = createPluginStore({
  database,
  auditStore,
  credentials: {
    readSecret: async () => null,
    create: async () => {
      throw new Error("the removal path asked the vault to create a secret");
    },
    updateSecret: async () => {
      throw new Error("the removal path asked the vault to write a secret");
    },
    revoke: async () => {
      throw new Error("the removal path asked the vault to revoke a secret");
    },
  },
  encryptionKey: "x".repeat(44),
  policy: () => ({ mode: "enforce", deny: [], allow: ["true"] }),
  broker,
});

function listing(name: string) {
  return {
    listActions: async () => [
      {
        slug: name,
        description: "Fetch things.",
        inputParameters: { type: "object", properties: {} },
        tags: ["readOnlyHint"],
        version: "20260903_00",
      },
    ],
    execute: async () => ({
      data: { ok: true },
      error: null,
      successful: true,
    }),
  };
}

afterAll(async () => {
  useComposioClient(null);
  await database.delete(pluginGrants).where(eq(pluginGrants.agentId, botId));
  await database
    .delete(mcpTools)
    .where(inArray(mcpTools.serverId, [serverId, keptServerId]));
  await database
    .delete(mcpServers)
    .where(inArray(mcpServers.id, [serverId, keptServerId]));
  await database.delete(agents).where(eq(agents.id, botId));
});

test("removing an app takes its grants with it, and adding it back grants nothing", async () => {
  useComposioClient(listing(actionName));

  await database
    .insert(agents)
    .values({ id: botId, name: botId, type: "built_in", configuration: {} })
    .onConflictDoNothing();

  await store.addBrokeredApp({
    slug,
    title: `Removed ${suite}`,
    by: "admin@openbot.test",
    connection: { kind: "consent" },
  });
  await store.grant("mcp", ref, botId, "admin@openbot.test");
  expect(
    (await store.listForAgent(botId)).tools.map((tool) => tool.ref),
  ).toContain(ref);

  useComposioClient(listing(keptAction));
  await store.addBrokeredApp({
    slug: keptSlug,
    title: `Kept ${suite}`,
    by: "admin@openbot.test",
    connection: { kind: "consent" },
  });
  await store.grant("mcp", keptRef, botId, "admin@openbot.test");

  events.length = 0;
  useComposioClient(listing(actionName));
  await store.removeServer(serverId, "admin@openbot.test");

  const left = await database
    .select({ ref: pluginGrants.ref })
    .from(pluginGrants)
    .where(and(eq(pluginGrants.ref, ref), eq(pluginGrants.agentId, botId)));
  expect(left).toEqual([]);

  const removal = events.find(
    (event) => event.payload.change === "mcp_server_removed",
  );
  expect(removal?.payload.releasedGrants).toEqual([ref]);
  expect(removal?.payload.bots).toEqual([botId]);

  const kept = await database
    .select({ ref: pluginGrants.ref })
    .from(pluginGrants)
    .where(and(eq(pluginGrants.ref, keptRef), eq(pluginGrants.agentId, botId)));
  expect(kept).toHaveLength(1);

  await store.addBrokeredApp({
    slug,
    title: `Removed ${suite}`,
    by: "admin@openbot.test",
    connection: { kind: "consent" },
  });

  expect((await store.decide("mcp", ref, botId)).allowed).toBe(false);
  expect(
    (await store.listForAgent(botId)).tools.map((tool) => tool.ref),
  ).not.toContain(ref);
});

test("a re-added app a Bot was never granted again refuses the call", async () => {
  const noAuthSlug = `noauth${suite}`;
  const noAuthServerId = `composio-${noAuthSlug}`;
  const noAuthAction = `${noAuthSlug.toUpperCase()}_READ`;
  const noAuthRef = `${noAuthServerId}/${noAuthAction}`;

  useComposioClient(listing(noAuthAction));

  await database
    .insert(agents)
    .values({ id: botId, name: botId, type: "built_in", configuration: {} })
    .onConflictDoNothing();

  try {
    await store.addBrokeredApp({
      slug: noAuthSlug,
      title: `No auth ${suite}`,
      by: "admin@openbot.test",
      connection: { kind: "no-auth" },
    });
    await store.grant("mcp", noAuthRef, botId, "admin@openbot.test");

    const before = await store.callTool({
      ref: noAuthRef,
      args: {},
      botId,
      actorId: "user_someone",
    });
    expect(before.isError).toBe(false);

    await store.removeServer(noAuthServerId, "admin@openbot.test");
    await store.addBrokeredApp({
      slug: noAuthSlug,
      title: `No auth ${suite}`,
      by: "admin@openbot.test",
      connection: { kind: "no-auth" },
    });

    await expect(
      store.callTool({
        ref: noAuthRef,
        args: {},
        botId,
        actorId: "user_someone",
      }),
    ).rejects.toThrow(noAuthRef);
  } finally {
    await database
      .delete(pluginGrants)
      .where(eq(pluginGrants.agentId, botId))
      .catch(() => undefined);
    await database
      .delete(mcpTools)
      .where(eq(mcpTools.serverId, noAuthServerId))
      .catch(() => undefined);
    await database
      .delete(mcpServers)
      .where(eq(mcpServers.id, noAuthServerId))
      .catch(() => undefined);
  }
});
