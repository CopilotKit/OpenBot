// server/tests/shared-gated-mode.integration.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
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

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const suite = randomUUID().slice(0, 8);
const app = `team-gh-${suite}`;
const bot = `bot-${suite}`;
const admin = `admin-${suite}`;
const asker = `asker-${suite}`;
const VENDOR_ID = `openbot-deployment:acme-${suite}:R`;

const broker: ConnectedAppBroker = {
  listApps: async () => [],
  ensureAuthConfig: async () => "standing",
  deleteAuthConfig: async () => {},
  authorize: async () => ({ redirectUrl: "https://vendor.example/consent" }),
  isConnected: async () => true,
  revoke: async () => true,
  connectionFields: async () => [],
  connectWithFields: async () => ({ accountId: "ca_1" }),
  revokeAccount: async () => {},
  accountName: async () => "acme-bot",
};

const policy = { mode: "enforce" as const, deny: [], allow: ["true"] };
const credentialsStub = {} as never;

async function seed() {
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
  await database.insert(brokeredConnections).values({
    provider: "composio",
    app,
    holder: "deployment",
    vendorUserId: VENDOR_ID,
    connectedBy: admin,
    verified: true,
  });
}

async function clean() {
  await database
    .delete(brokeredConnections)
    .where(eq(brokeredConnections.app, app));
  await database.delete(mcpServers).where(eq(mcpServers.id, app));
  await database.delete(agents).where(eq(agents.id, bot));
}

beforeEach(async () => {
  await clean();
});
afterEach(async () => {
  useComposioClient(null);
  await clean();
});

describe("connectionTokenFor's gatedMode guard", () => {
  test("refuses a call whose app turned Personal mid-flight, and never reaches the vendor", async () => {
    const sentAs: string[] = [];
    useComposioClient({
      listActions: async () => [],
      execute: async ({ userId }) => {
        sentAs.push(userId);
        return { successful: true, data: {}, error: null } as never;
      },
    });
    const store = createPluginStore({
      database,
      auditStore: createAuditStore(database),
      credentials: credentialsStub,
      encryptionKey: "x".repeat(44),
      policy: () => policy,
      broker,
      deploymentId: `acme-${suite}`,
      /*
       * `callTool` reads the app's mode once, through `requireServer`, before this gate ever runs —
       * that read is what seeds `gatedMode`. This gate is the one awaited step between that read and
       * `connectionTokenFor`'s own re-read, so flipping the row here reproduces exactly the race the
       * guard exists for: an administrator switching the app away from Shared while a call against it
       * is already in flight.
       */
      sharedUse: async () => {
        await database
          .update(mcpServers)
          .set({ accountMode: "personal", sharedVendorUserId: null })
          .where(eq(mcpServers.id, app));
        return { allowed: true };
      },
    });
    await seed();
    await store.grant(
      "mcp",
      `${app}/GITHUB_LIST_ISSUES`,
      bot,
      "admin@example.test",
    );

    await expect(
      store.callTool({
        ref: `${app}/GITHUB_LIST_ISSUES`,
        args: {},
        botId: bot,
        actorId: asker,
      }),
    ).rejects.toThrow(
      "Team GitHub changed how it is shared while this call was being checked, so it was not called. Ask again.",
    );
    expect(sentAs).toEqual([]);
  });
});
