// server/tests/store-account-ref.integration.test.ts
//
// THE STORE READS A STORED `(holder, user_id)` PAIR AS THE ACCOUNT IT NAMES, OR REFUSES.
//
// `asAccountRef` is the one reading, and its point is the `null`: a row that names no account this
// deployment may act in must stop the act rather than be rebuilt as some other account. `store.ts`
// had two readings of its own — one that absorbed an unreadable pair into `{ holder: "deployment" }`
// and one that minted `{ holder: "person", userId: "" }` — and both of them fed a REVOKE and an
// audit row. `brokered_connections_holder_check` is `(person AND user_id IS NOT NULL) OR
// (deployment AND user_id IS NULL)`, and `''` satisfies `IS NOT NULL`, so the person-with-no-user
// row IS writable and is what both tests below seed.
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { createAuditStore } from "../src/audit";
import { createDatabase } from "../src/db/client";
import { brokeredConnections, mcpServers } from "../src/db/schema";
import type { ConnectedAppBroker } from "../src/plugins/broker";
import type { AccountRef } from "../src/plugins/shared-accounts";
import { createPluginStore, PluginInvariantError } from "../src/plugins/store";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const suite = randomUUID().slice(0, 8);
const app = `nobody-gh-${suite}`;

/** Every account the broker was ASKED to end, whole, so a wrong holder is visible in the failure. */
const asked: AccountRef[] = [];
const broker = {
  grantIsLocal: true,
  authProviderOf: async () => null,
  authorizations: null,
  grantsFor: async () => [],
  listApps: async () => [],
  ensureAuthConfig: async () => "standing",
  deleteAuthConfig: async () => {},
  authorize: async () => ({
    redirectUrl: "https://vendor.example/consent",
    authorizationId: null,
  }),
  isConnected: async () => true,
  revoke: async ({ account }: { account: AccountRef }) => {
    asked.push(account);
    return true;
  },
  connectionFields: async () => [],
  connectWithFields: async () => ({ accountId: "ca_1" }),
  revokeAccount: async () => {},
  accountName: async () => "acme-bot",
} as unknown as ConnectedAppBroker;

function freshStore() {
  return createPluginStore({
    brokerProvider: "composio",
    database,
    auditStore: createAuditStore(database),
    credentials: {} as never,
    encryptionKey: "x".repeat(44),
    policy: () => ({ mode: "enforce" as const, deny: [], allow: ["true"] }),
    broker,
    deploymentId: `acme-${suite}`,
  });
}

/** A person row carrying no user id — written as `''`, which the table's CHECK does not stop. */
async function seedPersonWithNoUser() {
  await database.insert(mcpServers).values({
    id: app,
    title: "Team GitHub",
    vendor: "Composio",
    url: `composio://${app}`,
    provenance: "composio",
    authScheme: "OAUTH2",
  });
  await database.insert(brokeredConnections).values({
    provider: "composio",
    app,
    holder: "person",
    userId: "",
    vendorUserId: `vendor-${suite}`,
  });
}

afterEach(async () => {
  asked.length = 0;
  await database
    .delete(brokeredConnections)
    .where(eq(brokeredConnections.app, app));
  await database.delete(mcpServers).where(inArray(mcpServers.id, [app]));
});

describe("a stored pair that names nobody", () => {
  test("stops `removeServer` before the vendor is asked to end anybody's account", async () => {
    const store = freshStore();
    await seedPersonWithNoUser();

    const outcome = await store.removeServer(app, "admin@example.test").then(
      () => "removed",
      (error: unknown) => error,
    );

    expect(asked).toEqual([]);
    expect(outcome).toBeInstanceOf(PluginInvariantError);
    const rows = await database
      .select({ app: brokeredConnections.app })
      .from(brokeredConnections)
      .where(eq(brokeredConnections.app, app));
    expect(rows).toHaveLength(1);
  });

  test("stops the mode switch's read before it hands the account to a revoke", async () => {
    const store = freshStore();
    await seedPersonWithNoUser();

    // The sequence `account-mode.ts` runs: read every account on the app, then end each one.
    const outcome = await (async () => {
      const on = await store.accountsOn(app);
      if (!on) return "not brokered";
      for (const account of on.accounts) {
        await store.disconnectBrokered({
          toolkit: on.toolkit,
          account,
          by: "admin@example.test",
          reason: "mode_switched",
        });
      }
      return "ended";
    })().then(
      (answer) => answer,
      (error: unknown) => error,
    );

    expect(asked).toEqual([]);
    expect(outcome).toBeInstanceOf(PluginInvariantError);
  });
});

afterAll(async () => {
  await database.$client.close();
});
