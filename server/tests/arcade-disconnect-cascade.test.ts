// server/tests/arcade-disconnect-cascade.test.ts
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { createAuditStore } from "../src/audit";
import { createDatabase } from "../src/db/client";
import { auditEvents, brokeredConnections, mcpServers } from "../src/db/schema";
import type { ConnectedAppBroker } from "../src/plugins/broker";
import { createPluginStore } from "../src/plugins/store";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);

/* The pool this file opened, given back. `bun test` runs every file in one process and nothing
 * reaps an idle connection, so a pool held to the end of the run is two connections the rest of
 * the suite cannot have. */
afterAll(async () => {
  await database.$client.close();
});
const suite = randomUUID().slice(0, 8);
const gmail = `Gmail-${suite}`;
const calendar = `GoogleCalendar-${suite}`;
const slack = `Slack-${suite}`;
const drive = `GoogleDrive-${suite}`;
const lonely = `Lonely-${suite}`;
const keyed = `Keyed-${suite}`;

const providerOf: Record<string, string | null> = {
  [gmail]: "google",
  [calendar]: "google",
  [drive]: null, // the resolver cannot answer for this one
  [slack]: "slack",
  [lonely]: "google",
  // Gmail's connection exactly, except that this deployment holds a KEY for it.
  [keyed]: "google",
};

/** What the vendor was asked to revoke, in order, and whether it should refuse. */
const revoked: string[] = [];
let refuseRevoke = false;
/*
 * What `revoke` ANSWERS where it does not refuse. `false` is "there was nothing to withdraw", and
 * it is the answer no app but the asked one may be claimed gone on.
 */
let revokeAnswer = true;

const broker: ConnectedAppBroker = {
  grantIsLocal: false,
  authorizations: {
    status: async () => {
      throw new Error("nothing here polls an authorization");
    },
    confirmReturn: async () => {
      throw new Error("nothing here confirms a return leg");
    },
  },
  authProviderOf: async (toolkit) => providerOf[toolkit] ?? null,
  grantsFor: async () => [],
  listApps: async () => [],
  ensureAuthConfig: async () => "standing",
  deleteAuthConfig: async () => {},
  authorize: async () => ({
    redirectUrl: "https://vendor.example/consent",
    authorizationId: "ar_1",
  }),
  isConnected: async () => true,
  revoke: async ({ toolkit }) => {
    revoked.push(toolkit);
    if (refuseRevoke)
      throw new Error("Arcade revoke failed for 1 of 2 connections.");
    return revokeAnswer;
  },
  connectionFields: async () => [],
  connectWithFields: async () => ({ accountId: "ca_1" }),
  revokeAccount: async () => {},
  accountName: async () => "acme",
};

const store = createPluginStore({
  brokerProvider: "arcade",
  database,
  auditStore: createAuditStore(database),
  credentials: {} as never,
  encryptionKey: "x".repeat(44),
  policy: () => ({ mode: "enforce" as const, deny: [], allow: ["true"] }),
  broker,
});

const seeded: string[] = [];
async function hold(app: string, userId: string) {
  seeded.push(app);
  await database.insert(brokeredConnections).values({
    provider: "arcade",
    app,
    holder: "person",
    userId,
    vendorUserId: userId,
  });
}
/*
 * A row under the DEPLOYMENT's holder but on a person's vendor identity: `resolveSiblings` reads
 * the identity and so finds it, and `accountRow` reads the holder and so does not touch it.
 */
async function holdForDeployment(app: string, vendorUserId: string) {
  seeded.push(app);
  await database.insert(brokeredConnections).values({
    provider: "arcade",
    app,
    holder: "deployment",
    userId: null,
    vendorUserId,
  });
}
/*
 * The app's own row, which is where its auth scheme is recorded and so the only thing that says
 * whether this deployment holds a key for it.
 */
const servers: string[] = [];
async function server(app: string, authScheme: string) {
  servers.push(app);
  await database.insert(mcpServers).values({
    id: app,
    title: app,
    vendor: "Arcade",
    url: `arcade://${app}`,
    provenance: "arcade",
    authScheme,
  });
}
const rowsFor = async (apps: string[]) =>
  (
    await database
      .select({ app: brokeredConnections.app })
      .from(brokeredConnections)
      .where(inArray(brokeredConnections.app, apps))
      .orderBy(asc(brokeredConnections.app))
  ).map((row) => row.app);
// Filed by owner, because the trail is append-only and an earlier test's rows are still there.
const trailFor = (userId: string) =>
  database
    .select({
      app: auditEvents.targetId,
      payload: sql<Record<string, unknown>>`payload`,
    })
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.eventType, "mcp.account_disconnected"),
        sql`payload ->> 'owner' = ${userId}`,
      ),
    )
    .orderBy(asc(auditEvents.targetId));

// The audit trail is append-only, so it is never cleaned: every name here carries this run's suffix.
afterEach(async () => {
  if (seeded.length) {
    await database
      .delete(brokeredConnections)
      .where(inArray(brokeredConnections.app, seeded));
  }
  seeded.length = 0;
  if (servers.length) {
    await database.delete(mcpServers).where(inArray(mcpServers.id, servers));
  }
  servers.length = 0;
  revoked.length = 0;
  refuseRevoke = false;
  revokeAnswer = true;
});

const disconnect = (userId: string, toolkit: string) =>
  store.disconnectBrokered({
    toolkit,
    account: { holder: "person", userId, vendorUserId: userId },
    by: userId,
    reason: "self",
  });

describe("the disconnect cascade", () => {
  test("a disconnect whose siblings are two apps removes and audits BOTH local rows", async () => {
    const userId = `person-${suite}-a`;
    await hold(gmail, userId);
    await hold(calendar, userId);
    await hold(slack, userId); // another provider: untouched

    await disconnect(userId, gmail);

    expect(await rowsFor([gmail, calendar, slack])).toEqual([slack]);
    const trail = await trailFor(userId);
    expect(trail.map((event) => event.app)).toEqual([calendar, gmail].sort());
  });

  test("a partial vendor failure THROWS and every local row survives, with no audit row", async () => {
    const userId = `person-${suite}-b`;
    await hold(gmail, userId);
    await hold(calendar, userId);
    refuseRevoke = true;

    await expect(disconnect(userId, gmail)).rejects.toThrow(/revoke failed/);

    expect(await rowsFor([gmail, calendar])).toEqual([calendar, gmail].sort());
    expect(await trailFor(userId)).toEqual([]);
  });

  test("a disconnect with no siblings removes and audits exactly the one app", async () => {
    const userId = `person-${suite}-c`;
    await hold(lonely, userId);
    await hold(slack, userId);

    await disconnect(userId, lonely);

    expect(await rowsFor([lonely, slack])).toEqual([slack]);
    const trail = await trailFor(userId);
    expect(trail.map((event) => event.app)).toEqual([lonely]);
  });

  test("the audit payload carries the unanswered count, an integer and never names", async () => {
    const userId = `person-${suite}-d`;
    await hold(gmail, userId);
    await hold(calendar, userId);
    await hold(drive, userId); // its auth provider cannot be resolved

    await disconnect(userId, gmail);

    // The unanswered app is NOT touched (left out, never guessed)...
    expect(await rowsFor([gmail, calendar, drive])).toEqual([drive]);
    // ...and every row written says that one app was not known.
    const trail = await trailFor(userId);
    expect(trail).toHaveLength(2);
    for (const event of trail) {
      expect(event.payload.unansweredSiblings).toBe(1);
      expect(JSON.stringify(event.payload)).not.toContain(drive);
    }
  });

  /*
   * THE THREE RULES A CASCADE DELETE OBEYS, each asserted on the thing they protect: the row of an
   * app NOBODY ASKED ABOUT. All three live in `clearEndedSiblings` in `store.ts`.
   */
  test("a KEY sibling's row SURVIVES, and nothing is written about it", async () => {
    const userId = `person-${suite}-e`;
    await server(keyed, "API_KEY");
    await hold(gmail, userId);
    await hold(keyed, userId); // same identity, same provider — but a key, not a consent

    await disconnect(userId, gmail);

    // The one OAuth revoke never ended the key, so the row that is the only way to reach that
    // account is still here, and the trail claims nothing about it.
    expect(await rowsFor([gmail, keyed])).toEqual([keyed]);
    expect((await trailFor(userId)).map((event) => event.app)).toEqual([gmail]);
  });

  test("a revoke that ANSWERS FALSE leaves a sibling's row standing and unaudited", async () => {
    const userId = `person-${suite}-f`;
    await hold(gmail, userId);
    await hold(calendar, userId);
    revokeAnswer = false;

    await disconnect(userId, gmail);

    // Nothing was shown to have been withdrawn, so no app but the asked one is claimed gone.
    expect(await rowsFor([gmail, calendar])).toEqual([calendar]);
    const trail = await trailFor(userId);
    expect(trail.map((event) => event.app)).toEqual([gmail]);
    expect(trail[0]?.payload.vendorRevocationRequested).toBe(false);
  });

  test("a sibling this account holds NO ROW for gets no trail row", async () => {
    const userId = `person-${suite}-g`;
    await hold(gmail, userId);
    await holdForDeployment(calendar, userId); // a sibling, but not this account's row

    await disconnect(userId, gmail);

    // The row is another holder's and so was never this disconnect's to delete — and a row that
    // was not deleted has no vanished connection to explain.
    expect(await rowsFor([gmail, calendar])).toEqual([calendar]);
    expect((await trailFor(userId)).map((event) => event.app)).toEqual([gmail]);
  });
});
