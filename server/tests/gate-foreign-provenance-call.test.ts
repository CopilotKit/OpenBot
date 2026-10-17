// server/tests/gate-foreign-provenance-call.test.ts
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
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
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/*
 * THE EXEMPTION BELONGS TO THE BROKER THAT HOLDS THE GRANT, NOT TO WHICHEVER ONE IS CONFIGURED.
 *
 * `connectionTokenFor` waives the local connection row where the ACTIVE broker declares the grant
 * is the vendor's — Arcade checks per action, per call, at the vendor, so a local row would be a
 * weaker second copy of that check. A row minted at the OTHER broker is not covered by that
 * promise: nothing checks it at Arcade, because it is not an Arcade app. Read off the active
 * broker, the waiver crossed over to it and let a Composio app be called with no consent row of
 * any kind — on a deployment that cannot connect, check or disconnect that app at all.
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);

afterAll(async () => {
  await database.$client.close();
});

const suite = randomUUID().slice(0, 8);
const foreign = `left-over-gh-${suite}`;
const bot = `bot-${suite}`;
const admin = `admin-${suite}`;
const asker = `asker-${suite}`;

/** Arcade's shape: the grant is the vendor's, so no local row is demanded of its own apps. */
const brokerStub: ConnectedAppBroker = {
  grantIsLocal: false,
  authorizations: null,
  authProviderOf: async () => null,
  grantsFor: async () => [],
  listApps: async () => [],
  ensureAuthConfig: async () => "standing",
  deleteAuthConfig: async () => {},
  authorize: async () => ({
    redirectUrl: "https://vendor.example/consent",
    authorizationId: null,
  }),
  isConnected: async () => true,
  revoke: async () => true,
  connectionFields: async () => [],
  connectWithFields: async () => ({ accountId: "ca_1" }),
  revokeAccount: async () => {},
  accountName: async () => "acme-bot",
};

const store = createPluginStore({
  brokerProvider: "arcade",
  database,
  auditStore: createAuditStore(database),
  credentials: {} as never,
  encryptionKey: "x".repeat(44),
  policy: () => ({ mode: "enforce" as const, deny: [], allow: ["true"] }),
  broker: brokerStub,
  deploymentId: `acme-${suite}`,
  sharedUse: async () => ({ allowed: true }),
});

/** The ids the Composio transport was handed, which is where a call that went out is visible. */
function recordingTransport(sentAs: string[]) {
  useComposioClient({
    listActions: async () => [],
    execute: async ({ userId }) => {
      sentAs.push(userId);
      return { successful: true, data: {}, error: null } as never;
    },
  });
}

async function clean() {
  await database
    .delete(brokeredConnections)
    .where(eq(brokeredConnections.app, foreign));
  await database.delete(mcpServers).where(eq(mcpServers.id, foreign));
  await database.delete(agents).where(eq(agents.id, bot));
}

beforeEach(async () => {
  await clean();
  await database
    .insert(agents)
    .values({ id: bot, name: "Helper", type: "built_in", configuration: {} });
});
afterEach(async () => {
  useComposioClient(null);
  await clean();
});

describe("a brokered row minted at the other broker", () => {
  test("is not waved through by the configured broker's vendor-held grant", async () => {
    const sentAs: string[] = [];
    recordingTransport(sentAs);
    // A row left behind by a deployment that used to broker through Composio. Nothing here can
    // connect it, check it or end it: this deployment's broker is Arcade.
    await database.insert(mcpServers).values({
      id: foreign,
      title: "Left-over GitHub",
      vendor: "Composio",
      url: `composio://${foreign}`,
      provenance: "composio",
      authScheme: "OAUTH2",
      accountMode: "personal",
    });
    await database.insert(mcpTools).values({
      serverId: foreign,
      name: "GITHUB_LIST_ISSUES",
      vendorName: "GITHUB_LIST_ISSUES",
      description: "List issues.",
      effect: "read",
      version: "1",
    });
    await store.grant(
      "mcp",
      `${foreign}/GITHUB_LIST_ISSUES`,
      bot,
      `${admin}@example.test`,
    );

    await expect(
      store.callTool({
        ref: `${foreign}/GITHUB_LIST_ISSUES`,
        args: {},
        botId: bot,
        actorId: asker,
      }),
    ).rejects.toThrow(
      "You have not connected your Left-over GitHub account. Connect it and ask again.",
    );
    expect(sentAs).toEqual([]);
  });
});
