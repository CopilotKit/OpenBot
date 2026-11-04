// server/tests/store-account-ref.integration.test.ts
//
// THE STORE READS A STORED `(holder, user_id)` PAIR AS THE ACCOUNT IT NAMES, OR REFUSES.
//
// `asAccountRef` is the one reading, and its point is the `null`: a row that names no account this
// deployment may act in must stop the act rather than be rebuilt as some other account. `store.ts`
// had two readings of its own — one that absorbed an unreadable pair into `{ holder: "deployment" }`
// and one that minted `{ holder: "person", userId: "" }` — and both of them fed a REVOKE and an
// audit row. The local `brokered_connections_holder_check` let `''` through (it tests `IS NOT NULL`),
// so the person-with-no-user row was writable there. Brokered accounts are Intelligence connections
// now, and Intelligence refuses that pair outright, `''` and `null` alike: the tests below pin that
// refusal, that the acts the old row stopped then meet no account to hand a revoke, and that the
// reading itself still refuses the pair should one ever arrive.
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { randomUUID } from "node:crypto";
import { createAuditStore } from "../src/audit";
import { createDatabase } from "../src/db/client";
import type { ConnectedAppBroker } from "../src/plugins/broker";
import { type AccountRef, asAccountRef } from "../src/plugins/shared-accounts";
import { createPluginStore } from "../src/plugins/store";
import type { ConnectionsDirectory } from "../src/vault/directory";
import { brokeredId } from "../src/vault/ids";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import {
  removeConnectionsWhere,
  removeServers,
  seedServer,
  storedConnections,
  storedServer,
  useTestVault,
} from "./support/vault";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const suite = randomUUID().slice(0, 8);
const app = `nobody-gh-${suite}`;
let directory: ConnectionsDirectory;

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

/**
 * The app, and an attempt to store a person account on it carrying no user id: `''` and `null`, the
 * two spellings of nobody. Both are refused by Intelligence, so nothing is stored.
 */
async function seedPersonWithNoUser() {
  await seedServer({
    id: app,
    title: "Team GitHub",
    vendor: "Composio",
    url: `composio://${app}`,
    provenance: "composio",
    authScheme: "OAUTH2",
  });
  for (const userId of ["", null]) {
    await expect(
      directory.createConnection({
        kind: "brokered",
        id: `${brokeredId("composio", app, "person", userId)}:${userId === null ? "null" : "empty"}`,
        provider: "composio",
        app,
        holder: "person",
        userId: userId as string,
        vendorUserId: `vendor-${suite}`,
        connectedBy: null,
        verified: false,
        verifiedAt: null,
        probeAction: null,
      }),
    ).rejects.toThrow("CONNECTION_VALIDATION_ERROR");
  }
}

async function accountsStoredOn(name: string) {
  return (await storedConnections()).brokered.filter(
    (connection) => connection.app === name,
  );
}

beforeAll(async () => {
  directory = await useTestVault();
});

afterEach(async () => {
  asked.length = 0;
  await removeConnectionsWhere(
    (connection) => connection.kind === "brokered" && connection.app === app,
  );
  await removeServers([app]);
});

describe("a stored pair that names nobody", () => {
  test("cannot be stored, so `removeServer` never asks the vendor to end anybody's account", async () => {
    const store = freshStore();
    await seedPersonWithNoUser();
    expect(await accountsStoredOn(app)).toEqual([]);

    const outcome = await store.removeServer(app, "admin@example.test").then(
      () => "removed",
      (error: unknown) => error,
    );

    expect(asked).toEqual([]);
    expect(outcome).toBe("removed");
    expect(await storedServer(app)).toBeNull();
  });

  test("cannot be stored, so the mode switch's read hands no account to a revoke", async () => {
    const store = freshStore();
    await seedPersonWithNoUser();

    // The sequence `account-mode.ts` runs: read every account on the app, then end each one.
    const on = await store.accountsOn(app);
    expect(on).toEqual({ toolkit: app, accounts: [] });
    for (const account of on?.accounts ?? []) {
      await store.disconnectBrokered({
        toolkit: app,
        account,
        by: "admin@example.test",
        reason: "mode_switched",
      });
    }

    expect(asked).toEqual([]);
  });

  test("is still refused by the reading, should one ever arrive", () => {
    // The store reads every account through `asAccountRef`, and a `null` there stops the act with a
    // PluginInvariantError rather than rebuilding the pair as some other account.
    for (const userId of ["", null]) {
      expect(
        asAccountRef({
          holder: "person",
          userId,
          vendorUserId: `vendor-${suite}`,
        }),
      ).toBeNull();
    }
    expect(
      asAccountRef({
        holder: "deployment",
        userId: "someone",
        vendorUserId: `vendor-${suite}`,
      }),
    ).toBeNull();
  });
});

afterAll(async () => {
  await database.$client.close();
});
