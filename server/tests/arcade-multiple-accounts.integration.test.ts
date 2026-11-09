import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { createAuditStore } from "../src/audit";
import { createDatabase } from "../src/db/client";
import {
  agents,
  brokeredAccounts,
  brokeredConnections,
  mcpServers,
  mcpTools,
  pluginGrants,
} from "../src/db/schema";
import type { ConnectedAppBroker } from "../src/plugins/broker";
import {
  type AccountRef,
  anotherArcadeAccount,
} from "../src/plugins/shared-accounts";
import { createPluginStore, PluginRefusedError } from "../src/plugins/store";
import { stubBroker } from "./support/stub-broker";
import { testDatabaseUrl } from "./support/database";
import { removePeople, seedPeople } from "./support/people";

/**
 * ARCADE MIRRORS COMPOSIO: A PERSON'S SECOND ACCOUNT AT AN APP, AND A CALL THAT RUNS IN IT.
 *
 * Arcade keeps one account per user id and auth provider, so a person's second Gmail there is filed
 * under a further id of their own (`<their id>~<suffix>`). What is asserted: completing the consent
 * for that further id leaves the connection row naming the person's own id and records the further
 * account beside it; the page lists both by the address Arcade reports; a call naming the second
 * address runs AS the further id; a name the person does not hold is refused; no name runs as the
 * person's own id, which is the default.
 */

const database = createDatabase(testDatabaseUrl(), { max: 4 });
const suite = randomUUID().slice(0, 8);
const PERSON = `arcade-person-${suite}`;
const APP = `gmail-${suite}`;
const SERVER = `arcade-gmail-${suite}`;
const BOT = `bot-arcade-${suite}`;
const WORK = "dana@work.example";
const HOME = "dana.home@gmail.example";

const own: AccountRef = {
  holder: "person",
  userId: PERSON,
  vendorUserId: PERSON,
};
const further = anotherArcadeAccount(
  own as Extract<AccountRef, { holder: "person" }>,
);

/** Arcade's listing: one live account per user id, named by the address the provider reported. */
const identities = new Map<string, string>([
  [PERSON, WORK],
  [further.vendorUserId, HOME],
]);

const broker: ConnectedAppBroker = {
  ...stubBroker({
    grantIsLocal: true,
    authorizations: {
      status: async () => {
        throw new Error("nothing here polls an authorization");
      },
      confirmReturn: async () => {
        throw new Error("nothing here confirms a return leg");
      },
    },
  }).broker,
  accountsOf: async ({ account }) => {
    const identity = identities.get(account.vendorUserId);
    return identity ? [{ accountId: null, identity, connectedAt: null }] : [];
  },
};

const reached: { actorId?: string; accountId?: string }[] = [];

const store = createPluginStore({
  brokerProvider: "arcade",
  database,
  auditStore: createAuditStore(database),
  credentials: {} as never,
  encryptionKey: "x".repeat(44),
  policy: () => ({ mode: "enforce", deny: [], allow: ["true"] }),
  broker,
  deploymentId: `acme-${suite}`,
  callVendor: async (connection) => {
    reached.push({
      ...(connection.actorId === undefined
        ? {}
        : { actorId: connection.actorId }),
      ...(connection.accountId === undefined
        ? {}
        : { accountId: connection.accountId }),
    });
    return { text: "[]", isError: false };
  },
});

async function consentFor(account: AccountRef, authId: string) {
  const claimed = await store.claimAuthorizationAttempt({
    actorId: PERSON,
    serverId: SERVER,
    action: null,
    account,
  });
  if (!claimed.claimed) throw new Error("claim failed");
  await store.recordAuthorizationMint({
    actorId: PERSON,
    createdAt: claimed.attempt.createdAt,
    authId,
  });
  await store.completeAuthorizationAttempt({
    actorId: PERSON,
    authId,
    toolkit: APP,
    account,
    action: null,
    scopes: ["gmail.readonly"],
    authProvider: "google",
  });
}

const fetchEmails = (args: Record<string, unknown>) =>
  store.callTool({
    ref: `${SERVER}/Gmail_ListEmails`,
    args,
    botId: BOT,
    actorId: PERSON,
  });

beforeAll(async () => {
  await seedPeople(database, [PERSON]);
  await database.insert(mcpServers).values({
    id: SERVER,
    title: "Gmail",
    vendor: "Arcade",
    url: `arcade://${APP}`,
    provenance: "arcade",
    authScheme: "OAUTH2",
    accountMode: "personal",
  });
  await database.insert(mcpTools).values({
    serverId: SERVER,
    name: "Gmail_ListEmails",
    vendorName: "Gmail.ListEmails",
    description: "List emails.",
    effect: "read",
  });
  await database
    .insert(agents)
    .values({ id: BOT, name: "Helper", type: "built_in", configuration: {} });
  await store.grant(
    "mcp",
    `${SERVER}/Gmail_ListEmails`,
    BOT,
    "admin@example.com",
  );
});

afterAll(async () => {
  await database.delete(pluginGrants).where(eq(pluginGrants.agentId, BOT));
  await database.delete(agents).where(eq(agents.id, BOT));
  await database.delete(brokeredAccounts).where(eq(brokeredAccounts.app, APP));
  await database
    .delete(brokeredConnections)
    .where(eq(brokeredConnections.app, APP));
  await database.delete(mcpServers).where(eq(mcpServers.id, SERVER));
  await removePeople(database, [PERSON]);
  await database.$client.close();
});

describe("a person with two Gmail accounts at Arcade", () => {
  test("the second consent keeps the connection on the person's own id and records the further account", async () => {
    await consentFor(own, `ar_own_${suite}`);
    await consentFor(further, `ar_further_${suite}`);

    const connections = await database
      .select()
      .from(brokeredConnections)
      .where(
        and(
          eq(brokeredConnections.app, APP),
          eq(brokeredConnections.userId, PERSON),
        ),
      );
    expect(connections).toHaveLength(1);
    expect(connections[0]?.vendorUserId).toBe(PERSON);

    const listed = await store.syncBrokeredAccounts({
      toolkit: APP,
      account: own,
    });
    expect(
      listed.map(({ label, isDefault }) => ({ label, isDefault })),
    ).toEqual([
      { label: WORK, isDefault: true },
      { label: HOME, isDefault: false },
    ]);
  });

  test("a call naming the second address runs as the further id, and no name runs as the person", async () => {
    reached.length = 0;

    await fetchEmails({ account: HOME });
    await fetchEmails({});

    expect(reached).toEqual([
      { actorId: further.vendorUserId },
      { actorId: PERSON },
    ]);
  });

  test("a name the person does not hold is refused before the vendor is asked", async () => {
    reached.length = 0;

    await expect(
      fetchEmails({ account: "someone.else@work.example" }),
    ).rejects.toBeInstanceOf(PluginRefusedError);
    expect(reached).toEqual([]);
  });
});
