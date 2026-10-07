// server/tests/shared-brokered-store.integration.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { createAuditStore } from "../src/audit";
import { createDatabase } from "../src/db/client";
import {
  agents,
  brokeredConnections,
  mcpServers,
  mcpTools,
} from "../src/db/schema";
import type { ConnectedAppBroker } from "../src/plugins/broker";
import { useComposioClient } from "../src/plugins/composio";
import { createPluginStore } from "../src/plugins/store";
import { expectOnlyRefusal } from "./helpers/refusals";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const suite = randomUUID().slice(0, 8);
const app = `team-gh-${suite}`;
const bot = `bot-${suite}`;
const admin = `admin-${suite}`;
const asker = `asker-${suite}`;
const VENDOR_ID = `openbot-deployment:acme-${suite}:R`;
/*
 * A second row at the app's url. `zz-` sorts after `team-gh-` in any collation, so the seeded row
 * stays the one `brokeredAppRow` answers with — `order by id`, first row per url — and this is
 * always the duplicate.
 */
const duplicate = `zz-dup-${suite}`;

const revoked: string[] = [];
const broker: ConnectedAppBroker = {
  listApps: async () => [],
  ensureAuthConfig: async () => "standing",
  deleteAuthConfig: async () => {},
  authorize: async () => ({ redirectUrl: "https://vendor.example/consent" }),
  isConnected: async () => true,
  revoke: async ({ account }) => {
    revoked.push(account.vendorUserId);
    return true;
  },
  connectionFields: async () => [],
  connectWithFields: async () => ({ accountId: "ca_1" }),
  revokeAccount: async () => {},
  accountName: async () => "acme-bot",
};

const policy = { mode: "enforce" as const, deny: [], allow: ["true"] };
const credentialsStub = {} as never;

function freshStore() {
  return createPluginStore({
    database,
    auditStore: createAuditStore(database),
    credentials: credentialsStub,
    encryptionKey: "x".repeat(44),
    policy: () => policy,
    broker,
    deploymentId: `acme-${suite}`,
    sharedUse: async () => ({ allowed: true }),
  });
}

async function seedShared(
  store: ReturnType<typeof freshStore>,
  connected: boolean,
) {
  await database.insert(mcpServers).values({
    id: app,
    title: "Team GitHub",
    vendor: "Composio",
    url: `composio://${app}`,
    provenance: "composio",
    authScheme: "OAUTH2",
    accountMode: "shared",
    sharedVendorUserId: VENDOR_ID,
  });
  await database.insert(mcpTools).values({
    serverId: app,
    name: "GITHUB_LIST_ISSUES",
    description: "List issues.",
    effect: "read",
    version: "1",
  });
  await database
    .insert(agents)
    .values({ id: bot, name: "Helper", type: "built_in", configuration: {} });
  await store.grant(
    "mcp",
    `${app}/GITHUB_LIST_ISSUES`,
    bot,
    "admin@example.test",
  );
  if (connected) {
    await database.insert(brokeredConnections).values({
      provider: "composio",
      app,
      holder: "deployment",
      vendorUserId: VENDOR_ID,
      connectedBy: admin,
      verified: true,
    });
  }
}

async function clean() {
  await database
    .delete(brokeredConnections)
    .where(eq(brokeredConnections.app, app));
  await database
    .delete(mcpServers)
    .where(inArray(mcpServers.id, [app, duplicate]));
  await database.delete(agents).where(eq(agents.id, bot));
}

beforeEach(async () => {
  revoked.length = 0;
  await clean();
});
afterEach(async () => {
  useComposioClient(null);
  await clean();
});

describe("a shared app", () => {
  test("is called under the deployment's stored vendor id, not the asker's", async () => {
    const store = freshStore();
    await seedShared(store, true);
    const sentAs: string[] = [];
    useComposioClient({
      listActions: async () => [],
      execute: async ({ userId }) => {
        sentAs.push(userId);
        return { successful: true, data: {}, error: null } as never;
      },
    });
    await store.callTool({
      ref: `${app}/GITHUB_LIST_ISSUES`,
      args: {},
      botId: bot,
      actorId: asker,
    });
    expect(sentAs).toEqual([VENDOR_ID]);
  });

  test("ignores a Team Bot's owner as the credential actor", async () => {
    const store = freshStore();
    await seedShared(store, true);
    const sentAs: string[] = [];
    useComposioClient({
      listActions: async () => [],
      execute: async ({ userId }) => {
        sentAs.push(userId);
        return { successful: true, data: {}, error: null } as never;
      },
    });
    await store.callTool({
      ref: `${app}/GITHUB_LIST_ISSUES`,
      args: {},
      botId: bot,
      actorId: asker,
      credentialActorId: "the-owner",
    });
    expect(sentAs).toEqual([VENDOR_ID]);
  });

  test("with no account connected refuses with the shared sentence and only that one", async () => {
    const store = freshStore();
    await seedShared(store, false);
    const said = await store
      .callTool({
        ref: `${app}/GITHUB_LIST_ISSUES`,
        args: {},
        botId: bot,
        actorId: asker,
      })
      .then(
        () => "called",
        (error: Error) => error.message,
      );
    expectOnlyRefusal(said, "sharedNotConnected", "Team GitHub");
  });

  test("offboarding the admin who connected it leaves it in place", async () => {
    const store = freshStore();
    await seedShared(store, true);
    await store.retireConnectionsFor(admin, "hr@example.test");
    const rows = await database
      .select()
      .from(brokeredConnections)
      .where(eq(brokeredConnections.app, app));
    expect(rows).toHaveLength(1);
    expect(revoked).toEqual([]);
  });

  test("reconnecting a shared account records the latest administrator", async () => {
    const store = freshStore();
    await store.recordBrokeredConnection({
      toolkit: app,
      account: { holder: "deployment", vendorUserId: VENDOR_ID },
      connectedBy: "admin-a",
      verified: true,
      probeAction: null,
    });
    await store.recordBrokeredConnection({
      toolkit: app,
      account: { holder: "deployment", vendorUserId: VENDOR_ID },
      connectedBy: "admin-b",
      verified: true,
      probeAction: null,
    });
    const rows = await database
      .select({ connectedBy: brokeredConnections.connectedBy })
      .from(brokeredConnections)
      .where(
        and(
          eq(brokeredConnections.app, app),
          eq(brokeredConnections.holder, "deployment"),
        ),
      );
    expect(rows).toEqual([{ connectedBy: "admin-b" }]);
  });

  test("removing the app revokes the deployment account too", async () => {
    const store = freshStore();
    await seedShared(store, true);
    await store.removeServer(app, "admin@example.test");
    expect(revoked).toContain(VENDOR_ID);
  });

  test("audits the call as reached by the deployment, naming who asked", async () => {
    const events: { eventType: string; payload: Record<string, unknown> }[] =
      [];
    const store = createPluginStore({
      database,
      auditStore: { insert: async (event) => void events.push(event as never) },
      credentials: credentialsStub,
      encryptionKey: "x".repeat(44),
      policy: () => policy,
      broker,
      deploymentId: `acme-${suite}`,
      sharedUse: async () => ({ allowed: true }),
    });
    await seedShared(store, true);
    useComposioClient({
      listActions: async () => [],
      execute: async () =>
        ({ successful: true, data: {}, error: null }) as never,
    });
    await store.callTool({
      ref: `${app}/GITHUB_LIST_ISSUES`,
      args: {},
      botId: bot,
      actorId: asker,
    });
    const success = events.find(
      (event) => event.eventType === "mcp.call_succeeded",
    );
    expect(success?.payload).toMatchObject({
      actor: asker,
      reachedAs: "deployment",
    });
  });

  test("with no audience gate configured, a shared call is refused rather than allowed", async () => {
    const store = createPluginStore({
      database,
      auditStore: createAuditStore(database),
      credentials: credentialsStub,
      encryptionKey: "x".repeat(44),
      policy: () => policy,
      broker,
      deploymentId: `acme-${suite}`,
    });
    await seedShared(store, true);
    await expect(
      store.callTool({
        ref: `${app}/GITHUB_LIST_ISSUES`,
        args: {},
        botId: bot,
        actorId: asker,
      }),
    ).rejects.toThrow(/cannot check who may use it/);
  });
});

describe("a personal app", () => {
  test("still refuses a person with no account with the personal sentence", async () => {
    const store = freshStore();
    await seedShared(store, false);
    await database
      .update(mcpServers)
      .set({ accountMode: "personal", sharedVendorUserId: null })
      .where(eq(mcpServers.id, app));
    const said = await store
      .callTool({
        ref: `${app}/GITHUB_LIST_ISSUES`,
        args: {},
        botId: bot,
        actorId: asker,
      })
      .then(
        () => "called",
        (error: Error) => error.message,
      );
    expectOnlyRefusal(said, "personalNotConnected", "Team GitHub");
  });

  test("offboarding a person revokes only their own rows", async () => {
    const store = freshStore();
    await seedShared(store, true);
    await database
      .update(mcpServers)
      .set({ accountMode: "personal" })
      .where(eq(mcpServers.id, app));
    await database.insert(brokeredConnections).values({
      provider: "composio",
      app,
      holder: "person",
      userId: asker,
      vendorUserId: asker,
    });
    await store.retireConnectionsFor(asker, "hr@example.test");
    const left = await database
      .select({ holder: brokeredConnections.holder })
      .from(brokeredConnections)
      .where(
        and(
          eq(brokeredConnections.app, app),
          inArray(brokeredConnections.holder, ["person", "deployment"]),
        ),
      );
    expect(left).toEqual([{ holder: "deployment" }]);
    expect(revoked).toEqual([asker]);
  });
});

describe("a duplicate row at an app's url", () => {
  async function seedDuplicate(
    store: ReturnType<typeof createPluginStore>,
    columns: {
      accountMode: "personal" | "shared";
      sharedVendorUserId: string | null;
    },
  ) {
    await database.insert(mcpServers).values({
      id: duplicate,
      title: "Team GitHub (copy)",
      vendor: "Composio",
      url: `composio://${app}`,
      provenance: "composio",
      authScheme: "OAUTH2",
      ...columns,
    });
    await database.insert(mcpTools).values({
      serverId: duplicate,
      name: "GITHUB_LIST_ISSUES",
      description: "List issues.",
      effect: "read",
      version: "1",
    });
    await store.grant(
      "mcp",
      `${duplicate}/GITHUB_LIST_ISSUES`,
      bot,
      "admin@example.test",
    );
  }

  test("saying personal does not take a call to a Shared app round the audience gate", async () => {
    const gateSaw: { serverId: string }[] = [];
    const events: { eventType: string; payload: Record<string, unknown> }[] =
      [];
    const store = createPluginStore({
      database,
      auditStore: { insert: async (event) => void events.push(event as never) },
      credentials: credentialsStub,
      encryptionKey: "x".repeat(44),
      policy: () => policy,
      broker,
      deploymentId: `acme-${suite}`,
      sharedUse: async (input) => {
        gateSaw.push({ serverId: input.serverId });
        return { allowed: false, message: "Not for this audience." };
      },
    });
    await seedShared(store, true);
    await seedDuplicate(store, {
      accountMode: "personal",
      sharedVendorUserId: null,
    });
    const sentAs: string[] = [];
    useComposioClient({
      listActions: async () => [],
      execute: async ({ userId }) => {
        sentAs.push(userId);
        return { successful: true, data: {}, error: null } as never;
      },
    });
    await expect(
      store.callTool({
        ref: `${duplicate}/GITHUB_LIST_ISSUES`,
        args: {},
        botId: bot,
        actorId: asker,
      }),
    ).rejects.toThrow("Not for this audience.");
    expect(gateSaw).toEqual([{ serverId: app }]);
    expect(sentAs).toEqual([]);
    expect(
      events.find((event) => event.eventType === "mcp.call_rejected")?.payload,
    ).toMatchObject({ refusal: "shared_audience", reachedAs: "deployment" });
  });

  test("saying shared does not send a Personal app's call out as the deployment", async () => {
    const gateSaw: string[] = [];
    const events: { eventType: string; payload: Record<string, unknown> }[] =
      [];
    const store = createPluginStore({
      database,
      auditStore: { insert: async (event) => void events.push(event as never) },
      credentials: credentialsStub,
      encryptionKey: "x".repeat(44),
      policy: () => policy,
      broker,
      deploymentId: `acme-${suite}`,
      sharedUse: async (input) => {
        gateSaw.push(input.serverId);
        return { allowed: true };
      },
    });
    // The deployment account exists, so taking the Shared branch would succeed rather than refuse.
    await seedShared(store, true);
    await database
      .update(mcpServers)
      .set({ accountMode: "personal", sharedVendorUserId: null })
      .where(eq(mcpServers.id, app));
    await database.insert(brokeredConnections).values({
      provider: "composio",
      app,
      holder: "person",
      userId: asker,
      vendorUserId: asker,
      verified: true,
    });
    await seedDuplicate(store, {
      accountMode: "shared",
      sharedVendorUserId: VENDOR_ID,
    });
    const sentAs: string[] = [];
    useComposioClient({
      listActions: async () => [],
      execute: async ({ userId }) => {
        sentAs.push(userId);
        return { successful: true, data: {}, error: null } as never;
      },
    });
    await store.callTool({
      ref: `${duplicate}/GITHUB_LIST_ISSUES`,
      args: {},
      botId: bot,
      actorId: asker,
    });
    expect(sentAs).toEqual([asker]);
    expect(gateSaw).toEqual([]);
    expect(
      events.find((event) => event.eventType === "mcp.call_succeeded")?.payload,
    ).toMatchObject({ reachedAs: asker });
  });

  test("a mode written through the duplicate lands on the row that answers", async () => {
    const store = freshStore();
    await seedShared(store, false);
    await seedDuplicate(store, {
      accountMode: "shared",
      sharedVendorUserId: VENDOR_ID,
    });
    await store.setAccountModeColumns(duplicate, "personal", null);
    const rows = await database
      .select({ id: mcpServers.id, accountMode: mcpServers.accountMode })
      .from(mcpServers)
      .where(inArray(mcpServers.id, [app, duplicate]))
      .orderBy(mcpServers.id);
    expect(rows).toEqual([
      { id: app, accountMode: "personal" },
      { id: duplicate, accountMode: "shared" },
    ]);
  });
});
