import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { createAuditStore } from "../src/audit";
import { createDatabase } from "../src/db/client";
import { brokeredConnections, mcpServers } from "../src/db/schema";
import { BROKERED_PROFILE, type BrokerProvider } from "../src/plugins/access";
import type { ConnectedAppBroker } from "../src/plugins/broker";
import { createPluginStore } from "../src/plugins/store";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/*
 * `store.ts` reads the app out of a row's url through the provider's own parser, dispatched in
 * `access.ts` and keyed on the store's `brokerProvider`. These drive `accountsOn`, which reads the
 * toolkit off a row's url and answers nothing for a url that names no app at this store's broker.
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const suite = randomUUID().slice(0, 8);
const serverIds: string[] = [];
const connectionApps: string[] = [];

afterEach(async () => {
  for (const id of serverIds.splice(0))
    await database.delete(mcpServers).where(eq(mcpServers.id, id));
  for (const app of connectionApps.splice(0))
    await database
      .delete(brokeredConnections)
      .where(eq(brokeredConnections.app, app));
});
afterAll(async () => {
  await database.$client.close();
});

const broker = {} as ConnectedAppBroker;

function storeFor(brokerProvider: BrokerProvider) {
  return createPluginStore({
    database,
    auditStore: createAuditStore(database),
    credentials: {} as never,
    encryptionKey: "x".repeat(44),
    policy: () => ({ mode: "enforce" as const, deny: [], allow: ["true"] }),
    broker,
    brokerProvider,
    deploymentId: `acme-${suite}`,
  });
}

async function seed(provenance: BrokerProvider, url: string, app: string) {
  const id = `dispatch-${suite}-${randomUUID().slice(0, 6)}`;
  await database.insert(mcpServers).values({
    id,
    title: "Example",
    // What production mints: the broker's label out of `BROKERED_PROFILE`, never the lower-case
    // provider key. The provenance column is the provider key; the vendor column never is.
    vendor: BROKERED_PROFILE[provenance].vendor,
    url,
    provenance,
    authScheme: "OAUTH2",
  });
  serverIds.push(id);
  await database.insert(brokeredConnections).values({
    provider: provenance,
    app,
    holder: "person",
    userId: `user-${suite}`,
    vendorUserId: `vendor-${suite}`,
  });
  connectionApps.push(app);
  return id;
}

describe("the toolkit a row names is read by the store's own provider", () => {
  test("an arcade://Gmail row resolves to Gmail with case intact under arcade", async () => {
    const id = await seed("arcade", `arcade://Gmail`, `Gmail`);
    const answer = await storeFor("arcade").accountsOn(id);
    expect(answer?.toolkit).toBe("Gmail");
    expect(answer?.accounts).toHaveLength(1);
  });

  test("the same row under composio names no app and is refused, not mis-parsed", async () => {
    const id = await seed("arcade", `arcade://Gmail`, `Gmail`);
    expect(await storeFor("composio").accountsOn(id)).toBeNull();
  });

  test("a composio://gmail row under composio is unchanged", async () => {
    const id = await seed("composio", `composio://gmail`, `gmail`);
    const answer = await storeFor("composio").accountsOn(id);
    expect(answer?.toolkit).toBe("gmail");
    expect(answer?.accounts).toHaveLength(1);
  });

  /*
   * THE MIRROR OF THE REFUSAL ABOVE. The dispatch is a table with an entry per provider, so a guard
   * proved in one direction only is a guard proved for one entry only: an arcade store reading a
   * `composio://` row has to answer nothing for the same reason, and nothing about the first case
   * says the second one holds.
   */
  test("a composio://gmail row under arcade names no app and is refused, not mis-parsed", async () => {
    const id = await seed("composio", `composio://gmail`, `gmail`);
    expect(await storeFor("arcade").accountsOn(id)).toBeNull();
  });
});
