// server/tests/store-vendor-vocabulary.test.ts
/**
 * THE SENTENCES `store.ts` HANDS A PERSON NAME THE BROKER THIS DEPLOYMENT ACTUALLY RUNS.
 *
 * Two of the store's refusals spelled the literal "Composio" into prose a reader acts on: the name
 * collision an administrator meets when they add a server by URL over a brokered row, and the
 * retry a person is told to make when a re-check could not be made. Both reach a browser — the
 * first as a 400 off `CustomServerRefusedError`, the second as a 400 off `PluginRefusedError` —
 * and on an Arcade deployment both named a vendor this deployment holds no key for.
 *
 * ONE DATABASE, TWO STORES, because the only thing under test is which vocabulary a store built on
 * one provider reads. Rows are inserted rather than enabled through `addBrokeredApp`: what these
 * refusals read off a row is its provenance, its url and its scheme, and enabling for real would
 * put a vendor listing in front of an assertion that has nothing to do with one.
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import { createAuditStore } from "../src/audit";
import { createDatabase } from "../src/db/client";
import {
  agents,
  brokeredConnections,
  mcpServers,
  mcpTools,
} from "../src/db/schema";
import type { BrokerProvider } from "../src/plugins/access";
import type { ConnectedAppBroker } from "../src/plugins/broker";
import { createPluginStore } from "../src/plugins/store";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);

afterAll(async () => {
  await database.$client.close();
});

const suite = randomUUID().slice(0, 8);

/** Nothing here reaches a vendor: every refusal under test is decided off the row. */
const broker = {
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
  accountName: async () => null,
} as unknown as ConnectedAppBroker;

function storeOn(provider: BrokerProvider) {
  return createPluginStore({
    brokerProvider: provider,
    database,
    auditStore: createAuditStore(database),
    credentials: {} as never,
    encryptionKey: "x".repeat(44),
    policy: () => ({ mode: "enforce" as const, deny: [], allow: ["true"] }),
    broker,
  });
}

const STORE: Record<BrokerProvider, ReturnType<typeof storeOn>> = {
  composio: storeOn("composio"),
  arcade: storeOn("arcade"),
};

const VENDOR: Record<BrokerProvider, string> = {
  composio: "Composio",
  arcade: "Arcade",
};

const seededServers: string[] = [];
const seededApps: string[] = [];

/** A brokered app as its provider spells it, inserted whole. */
async function brokeredApp(provider: BrokerProvider, toolkit: string) {
  // NOT the `${provider}-` id `addBrokeredApp` composes: an id in a broker's reserved namespace is
  // refused by its own guard before `requireNotBrokered` is ever asked, and that is a different
  // refusal with a different sentence.
  const id = `held-${toolkit.toLowerCase()}`;
  seededServers.push(id);
  await database.insert(mcpServers).values({
    id,
    title: toolkit,
    vendor: VENDOR[provider],
    url: `${provider}://${toolkit}`,
    provenance: provider,
    authScheme: "API_KEY",
  });
  return id;
}

afterEach(async () => {
  if (seededServers.length) {
    await database
      .delete(mcpTools)
      .where(inArray(mcpTools.serverId, seededServers));
    await database
      .delete(mcpServers)
      .where(inArray(mcpServers.id, seededServers));
  }
  if (seededApps.length)
    await database
      .delete(brokeredConnections)
      .where(inArray(brokeredConnections.app, seededApps));
  seededServers.length = 0;
  seededApps.length = 0;
});

/**
 * ADDING A SERVER BY URL OVER A BROKERED ROW. The refusal names the vendor whose accounts are
 * standing behind that row, which is the vendor the administrator has to go and remove the app
 * from.
 */
describe("the brokered-name collision names the active vendor", () => {
  for (const provider of ["arcade", "composio"] as BrokerProvider[]) {
    test(`on ${provider}`, async () => {
      const toolkit = `Gmail${suite}`;
      const id = await brokeredApp(provider, toolkit);

      const refused = await STORE[provider]
        .addCustomServer({
          id,
          title: "Collector",
          url: "https://collector.example/mcp",
          by: "admin@example.test",
        })
        .then(
          () => null,
          (error: Error) => error.message,
        );

      expect(refused).not.toBeNull();
      expect(refused).toContain(VENDOR[provider]);
      expect(refused).not.toContain(
        VENDOR[provider === "arcade" ? "composio" : "arcade"],
      );
    });
  }
});

/**
 * A RE-CHECK THAT COULD NOT BE MADE. The probe itself has no second implementation yet and says so
 * in its own words; what this pins is the RETRY the person is told to make, which is about the
 * vendor this deployment is waiting on and not about the one the probe was written for.
 */
describe("the re-check retry names the active vendor", () => {
  test("on arcade", async () => {
    const toolkit = `Slack${suite}`;
    const id = await brokeredApp("arcade", toolkit);
    seededApps.push(toolkit);
    await database.insert(mcpTools).values({
      serverId: id,
      name: `${toolkit}.WhoAmI`,
      vendorName: `${toolkit}.WhoAmI`,
      description: "Says who the key belongs to.",
      effect: "read",
      version: "1.0",
    });
    await database.insert(brokeredConnections).values({
      provider: "arcade",
      app: toolkit,
      holder: "person",
      userId: "person-1",
      vendorUserId: "person-1",
    });

    const refused = await STORE.arcade
      .recheckBrokeredConnection({
        toolkit,
        account: {
          holder: "person",
          userId: "person-1",
          vendorUserId: "person-1",
        },
        by: "person-1",
      })
      .then(
        () => null,
        (error: Error) => error.message,
      );

    expect(refused).toContain(
      "pressing Re-check again when Arcade is answering",
    );
    expect(refused).not.toContain("when Composio is answering");
  });
});

/**
 * A BROKERED ROW WHOSE URL NAMES NO APP. Nothing in the product writes one — a hand edit or an old
 * backup does — and the invariant it raises reaches an operator as a 409 off `isDeploymentFault`.
 * It named the wrong vendor on an Arcade deployment, which is the same defect wearing an
 * invariant's clothes.
 */
describe("the brokered-credential invariant names the active vendor", () => {
  test("on arcade", async () => {
    const id = `held-orphan-${suite}`;
    const botId = `bot-${suite}`;
    const action = "Orphan.Read";
    seededServers.push(id);
    await database.insert(agents).values({
      id: botId,
      name: "Helper",
      type: "built_in",
      configuration: {},
    });
    await database.insert(mcpServers).values({
      id,
      title: "Orphan",
      vendor: "Arcade",
      // Brokered provenance, and a url that names no app at all.
      url: "https://orphan.example/mcp",
      provenance: "arcade",
      authScheme: "API_KEY",
      accountMode: "personal",
    });
    await database.insert(mcpTools).values({
      serverId: id,
      name: action,
      vendorName: action,
      description: "Reads something.",
      effect: "read",
      version: "1.0",
    });
    await STORE.arcade.grant(
      "mcp",
      `${id}/${action}`,
      botId,
      "admin@example.test",
    );

    const raised = await STORE.arcade
      .callTool({
        ref: `${id}/${action}`,
        args: {},
        botId,
        actorId: "person-1",
      })
      .then(
        () => null,
        (error: Error) => error.message,
      );

    expect(raised).toContain("Arcade");
    expect(raised).not.toContain("Composio");

    await database.delete(agents).where(inArray(agents.id, [botId]));
  });
});

/**
 * A TOOL ROW AN OLD REPLICA WROTE. During a rolling deploy a replica built before 0057 still lists
 * tools, and it inserts `mcp_tools` rows with no `vendor_name` at all; 0058's backfill has already
 * run by then and will not run again. Every reader takes the vendor's spelling through
 * `vendorNameOf` (`coalesce(vendor_name, name)`), so such a row still answers to its own name. A
 * raw `vendorName` read would answer null here, and this is the case that says so.
 */
describe("a tool row with no vendor_name still answers to its name", () => {
  async function writtenByAnOldReplica() {
    const toolkit = `Notion${suite}`;
    const id = await brokeredApp("arcade", toolkit);
    const name = `${toolkit}.WhoAmI`;
    // Exactly what a pre-0057 replica inserts: the column is not named, so it is null.
    await database.insert(mcpTools).values({
      serverId: id,
      name,
      description: "Says who the key belongs to.",
      effect: "read",
      version: "1.0",
    });
    return { id, name };
  }

  test("the per-action gate finds the action", async () => {
    const { id, name } = await writtenByAnOldReplica();
    expect(await STORE.arcade.serverPublishesAction(id, name)).toBe(true);
  });

  test("the re-check probe is offered it, under that name", async () => {
    const { id, name } = await writtenByAnOldReplica();
    expect(await STORE.arcade.probeActionFor(id)).toEqual({
      name,
      version: "1.0",
    });
  });
});
