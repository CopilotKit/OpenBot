// server/tests/remove-server-foreign-provenance.test.ts
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
import type { BrokerProvider } from "../src/plugins/access";
import type { ConnectedAppBroker } from "../src/plugins/broker";
import { createPluginStore } from "../src/plugins/store";
import { auditRows, useTestAuditTrail } from "./support/audit";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import {
  removeConnectionsWhere,
  removeServers,
  seedBrokered,
  seedServer,
  storedConnections,
  storedServer,
  useTestVault,
} from "./support/vault";

/*
 * WHAT A ROW LEFT BEHIND BY THE OTHER BROKER IS REMOVED AS.
 *
 * `mcp_servers.provenance` records which broker a row was minted at, and a deployment that has
 * switched broker — or a restore, or a hand edit — holds rows whose provenance is NOT the
 * configured provider. `removeServer` read three different answers to "which vendor is this": the
 * app slug off the ROW's provenance, the connection rows off the CONFIGURED provider, and the
 * revocation off the ACTIVE broker. So a foreign row's slug was handed to the wrong vendor while
 * the deletes beneath it matched nothing, and the removal reported success either way.
 *
 * SCOPING. `audit_events` is append-only and brokered accounts are long-lived in the one
 * Intelligence project every file shares, so every assertion is keyed on names this file alone
 * writes.
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);

beforeAll(async () => {
  await useTestVault();
});
useTestAuditTrail();

afterAll(async () => {
  await database.$client.close();
});

const suite = randomUUID().slice(0, 8);
const apps: string[] = [];
let n = 0;

function run() {
  n += 1;
  const tag = `${suite}${n}`;
  return { app: `Gmail-${tag}`, person: `person-${tag}` };
}

/** Everything the broker was asked, by name, so "which vendor was asked" is an assertion. */
function recorder() {
  const asked: { revoked: string[]; configsDeleted: string[] } = {
    revoked: [],
    configsDeleted: [],
  };
  const broker: ConnectedAppBroker = {
    grantIsLocal: true,
    authorizations: {
      status: async () => {
        throw new Error("nothing here polls an authorization");
      },
      confirmReturn: async () => {
        throw new Error("nothing here confirms a return leg");
      },
    },
    authProviderOf: async (toolkit) => toolkit,
    grantsFor: async () => [],
    listApps: async () => [],
    ensureAuthConfig: async () => "standing",
    deleteAuthConfig: async (toolkit) => {
      asked.configsDeleted.push(toolkit);
    },
    authorize: async () => ({
      redirectUrl: "https://vendor.example/consent",
      authorizationId: "ar_1",
    }),
    isConnected: async () => true,
    revoke: async (input) => {
      asked.revoked.push(input.toolkit);
      return true;
    },
    connectionFields: async () => [],
    connectWithFields: async () => ({ accountId: "ca_1" }),
    revokeAccount: async () => {},
    accountName: async () => "acme",
  };
  return { asked, broker };
}

/** A store whose configured provider is Composio: the only vendor it can reach. */
function composioStore(broker: ConnectedAppBroker) {
  return createPluginStore({
    brokerProvider: "composio",
    database,
    auditStore: createAuditStore(database),
    credentials: {} as never,
    encryptionKey: "x".repeat(44),
    policy: () => ({ mode: "enforce" as const, deny: [], allow: ["true"] }),
    broker,
    deploymentId: "acme",
    sharedUse: async () => ({ allowed: true }),
  });
}

async function server(id: string, provenance: string, url: string) {
  apps.push(id);
  await seedServer({
    id,
    title: id,
    vendor: provenance === "arcade" ? "Arcade" : "Composio",
    url,
    provenance,
    authScheme: "OAUTH2",
    accountMode: "personal",
  });
}

async function hold(provider: BrokerProvider, app: string, userId: string) {
  apps.push(app);
  await seedBrokered({
    provider,
    app,
    holder: "person",
    userId,
    vendorUserId: userId,
  });
}

const rowsFor = async (names: string[]) =>
  (await storedConnections()).brokered
    .filter((connection) => names.includes(connection.app))
    .map((connection) => `${connection.provider}:${connection.app}`)
    .sort();

/** Every `mcp.account_disconnected` row under these apps, ordered by app. */
const trailFor = async (names: string[]) =>
  (
    await Promise.all(
      names.map((name) =>
        auditRows({ eventType: "mcp.account_disconnected", targetId: name }),
      ),
    )
  )
    .flat()
    .map((row) => ({ app: row.targetId, payload: row.payload }))
    .sort((a, b) => (a.app ?? "").localeCompare(b.app ?? ""));

afterEach(async () => {
  if (apps.length) {
    const named = new Set(apps);
    await removeConnectionsWhere(
      (connection) =>
        connection.kind === "brokered" && named.has(connection.app),
    );
    await removeServers(apps);
  }
  apps.length = 0;
});

describe("removing a server whose provenance is not the configured provider", () => {
  test("asks no vendor about it and still takes that broker's own rows away", async () => {
    const t = run();
    const { asked, broker } = recorder();
    await server(t.app, "arcade", `arcade://${t.app}`);
    await hold("arcade", t.app, t.person);
    await hold("arcade", t.app, `${t.person}-2`);

    await composioStore(broker).removeServer(t.app, "admin");

    // The configured vendor is Composio and this app is not one of its: it is asked nothing at all.
    expect(asked.revoked).toEqual([]);
    expect(asked.configsDeleted).toEqual([]);
    // And the rows the row's OWN broker left behind are gone, rather than standing under a
    // removal that reported success.
    expect(await rowsFor([t.app])).toEqual([]);
    // Each is written down as ended with nothing claimed of a vendor nobody could ask.
    const trail = await trailFor([t.app]);
    expect(trail.length).toBe(2);
    for (const event of trail) {
      expect(event.payload).toMatchObject({
        reason: "mcp_server_removed",
        vendorRevocationRequested: false,
      });
    }
    // The app itself goes, as it always did.
    expect(await storedServer(t.app)).toBeNull();
  });

  test("a row of the configured provider's own is still revoked at the vendor", async () => {
    const t = run();
    const slug = t.app.toLowerCase();
    const { asked, broker } = recorder();
    await server(slug, "composio", `composio://${slug}`);
    await hold("composio", slug, t.person);

    await composioStore(broker).removeServer(slug, "admin");

    expect(asked.revoked).toEqual([slug]);
    expect(asked.configsDeleted).toEqual([slug]);
    expect(await rowsFor([slug])).toEqual([]);
    const trail = await trailFor([slug]);
    expect(trail.length).toBe(1);
    expect(trail[0]?.payload).toMatchObject({
      reason: "mcp_server_removed",
      vendorRevocationRequested: true,
    });
  });
});
