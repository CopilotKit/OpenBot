import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { createAuditStore } from "../src/audit";
import { createDatabase } from "../src/db/client";
import { pluginGrants } from "../src/db/schema";
import type { ConnectedAppBroker } from "../src/plugins/broker";
import { useComposioClient } from "../src/plugins/composio";
import { createPluginStore, type PluginStore } from "../src/plugins/store";
import { removeBots, seedBot } from "./support/bots";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import {
  purgeSecrets,
  recordingCredentialStore,
  removeServers,
  useTestVault,
} from "./support/vault";

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

const broker: ConnectedAppBroker = {
  // This stub stands in for Composio, whose grant is held locally; see `ConnectedAppBroker.grantIsLocal`.
  grantIsLocal: true,
  // Nothing here asks what auth provider a connection is held under.
  authProviderOf: async () => null,
  // Nothing here reads either member; both are declared because the seam requires a broker to
  // SAY what it runs — see `ConnectedAppBroker.authorizations`.
  authorizations: null,
  grantsFor: async () => [],
  listApps: async () => [],
  ensureAuthConfig: async () => undefined,
  deleteAuthConfig: async () => undefined,
  authorize: async () => {
    throw new Error("the removal path asked the broker to begin a connection");
  },
  isConnected: async () => true,
  revoke: async () => true,
  accountName: async () => null,
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

// The real vault, recording what the removal path asked of it: it must ask nothing, since an app
// connected by consent holds no secret here to create, write or revoke.
const vaultCalls: string[] = [];
const vaultCreated: string[] = [];
let store: PluginStore;

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
  await removeServers([serverId, keptServerId]);
  await purgeSecrets(vaultCreated);
  await removeBots([botId]);
});

// The Bot both tests grant to, made once so either test runs on its own.
beforeAll(async () => {
  await useTestVault();
  store = createPluginStore({
    brokerProvider: "composio",
    database,
    auditStore,
    credentials: await recordingCredentialStore({
      calls: vaultCalls,
      created: vaultCreated,
    }),
    encryptionKey: "x".repeat(44),
    policy: () => ({ mode: "enforce", deny: [], allow: ["true"] }),
    broker,
  });
  await seedBot({ id: botId, name: botId, type: "built_in" });
});

test("removing an app takes its grants with it, and adding it back grants nothing", async () => {
  useComposioClient(listing(actionName));

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
  expect(vaultCalls).toEqual([]);
});

test("a re-added app a Bot was never granted again refuses the call", async () => {
  const noAuthSlug = `noauth${suite}`;
  const noAuthServerId = `composio-${noAuthSlug}`;
  const noAuthAction = `${noAuthSlug.toUpperCase()}_READ`;
  const noAuthRef = `${noAuthServerId}/${noAuthAction}`;

  useComposioClient(listing(noAuthAction));

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
    expect(vaultCalls).toEqual([]);
  } finally {
    await database
      .delete(pluginGrants)
      .where(eq(pluginGrants.agentId, botId))
      .catch(() => undefined);
    await removeServers([noAuthServerId]);
  }
});

afterAll(async () => {
  await database.$client.close();
});
