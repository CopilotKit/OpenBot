// server/tests/arcade-attempt-store.integration.test.ts
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { createAuditStore } from "../src/audit";
import { createDatabase } from "../src/db/client";
import { mcpServers, pendingAuthorizations } from "../src/db/schema";
import type { ConnectedAppBroker } from "../src/plugins/broker";
import type { AccountRef } from "../src/plugins/shared-accounts";
import { createPluginStore } from "../src/plugins/store";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import { removePeople, seedPeople } from "./support/people";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const suite = randomUUID().slice(0, 8);
const serverId = `arcade-attempt-store-${suite}`;

const broker: ConnectedAppBroker = {
  // Arcade holds the grant at the vendor, not locally; see `ConnectedAppBroker.grantIsLocal`.
  grantIsLocal: false,
  // Nothing here asks what auth provider a connection is held under.
  authProviderOf: async () => null,
  // Arcade runs the correlated, pollable flow, so this stub DECLARES the sub-surface rather
  // than a null; nothing here reaches either member. See `ConnectedAppBroker.authorizations`.
  authorizations: {
    status: async () => {
      throw new Error("nothing here polls an authorization");
    },
    confirmReturn: async () => {
      throw new Error("nothing here confirms a return leg");
    },
  },
  grantsFor: async () => [],
  listApps: async () => [],
  ensureAuthConfig: async () => "standing",
  deleteAuthConfig: async () => {},
  authorize: async () => ({
    redirectUrl: "https://vendor.example/consent",
    authorizationId: "ar_stub",
  }),
  isConnected: async () => true,
  revoke: async () => true,
  connectionFields: async () => [],
  connectWithFields: async () => ({ accountId: "ca_1" }),
  revokeAccount: async () => {},
  accountName: async () => "acme-bot",
};

const policy = { mode: "enforce" as const, deny: [], allow: ["true"] };

const store = createPluginStore({
  brokerProvider: "arcade",
  database,
  auditStore: createAuditStore(database),
  credentials: {} as never,
  encryptionKey: "x".repeat(44),
  policy: () => policy,
  broker,
  deploymentId: `acme-${suite}`,
  sharedUse: async () => ({ allowed: true }),
});

const account = (actor: string): AccountRef => ({
  holder: "person",
  userId: actor,
  vendorUserId: `v-${actor}`,
});

const claim = (actorId: string, action = "connect") =>
  store.claimAuthorizationAttempt({
    actorId,
    serverId,
    action,
    account: account(actorId),
  });

const age = (actorId: string, interval: string) =>
  database.execute(
    sql`update pending_authorizations set created_at = created_at - ${interval}::interval where actor_id = ${actorId}`,
  );

/**
 * An actor id for this suite, AND THE PERSON BEHIND IT.
 *
 * `pending_authorizations.actor_id` keys to `users` and cascades (`.user_id` must equal it), so an
 * attempt cannot be written for somebody who does not exist. Seeding here rather than in each case
 * keeps the cases about the store: a case that invented its own id would be refused by the foreign
 * key, and the refusal would read as the store failing to claim.
 */
const actors: string[] = [];
const actor = async (name: string) => {
  const id = `${name}-${suite}`;
  actors.push(id);
  await seedPeople(database, [id]);
  return id;
};

beforeAll(async () => {
  await database.insert(mcpServers).values({
    id: serverId,
    title: "Attempt store",
    vendor: "Arcade",
    url: "https://example.invalid/mcp",
  });
});

afterAll(async () => {
  // Cascades to the attempts.
  await database.delete(mcpServers).where(eq(mcpServers.id, serverId));
  await removePeople(database, actors);
  await database.$client.close();
});

describe("claimAuthorizationAttempt", () => {
  test("succeeds when no attempt exists", async () => {
    const a = await actor("fresh");
    const got = await claim(a);
    expect(got.claimed).toBe(true);
    if (!got.claimed) return;
    expect(got.attempt.actorId).toBe(a);
    expect(got.attempt.serverId).toBe(serverId);
    expect(got.attempt.holder).toBe("person");
    expect(got.attempt.userId).toBe(a);
    expect(got.attempt.vendorUserId).toBe(`v-${a}`);
    expect(got.attempt.authId).toBeNull();
  });

  test("a second claim while the first is live returns zero rows and answers the live row", async () => {
    const a = await actor("live");
    const first = await claim(a, "connect");
    const second = await claim(a, "reconnect");
    expect(first.claimed).toBe(true);
    expect(second.claimed).toBe(false);
    if (first.claimed && !second.claimed) {
      expect(second.live?.actorId).toBe(a);
      expect(second.live?.action).toBe("connect");
      expect(second.live?.createdAt.getTime()).toBe(
        first.attempt.createdAt.getTime(),
      );
    }
  });

  test("succeeds after the first expired, replacing it", async () => {
    const a = await actor("expired");
    await claim(a, "old");
    await age(a, "16 minutes");
    const got = await claim(a, "new");
    expect(got.claimed).toBe(true);
    const rows = await database
      .select()
      .from(pendingAuthorizations)
      .where(eq(pendingAuthorizations.actorId, a));
    expect(rows.length).toBe(1);
    expect(rows[0]?.action).toBe("new");
  });

  test("succeeds after the first completed, replacing it", async () => {
    const a = await actor("completed");
    await claim(a, "old");
    await database.execute(
      sql`update pending_authorizations set completed_at = now(), outcome = 'completed' where actor_id = ${a}`,
    );
    const got = await claim(a, "new");
    expect(got.claimed).toBe(true);
    const rows = await database
      .select()
      .from(pendingAuthorizations)
      .where(eq(pendingAuthorizations.actorId, a));
    expect(rows[0]?.action).toBe("new");
    expect(rows[0]?.completedAt).toBeNull();
    expect(rows[0]?.outcome).toBeNull();
  });

  test("two concurrent claims by one actor: exactly one wins", async () => {
    const a = await actor("race");
    const results = await Promise.all([claim(a, "one"), claim(a, "two")]);
    expect(results.filter((r) => r.claimed).length).toBe(1);
    expect(results.filter((r) => !r.claimed).length).toBe(1);
  });
});

describe("recordAuthorizationMint", () => {
  test("writes the ar_ onto the attempt and leaves another actor's alone", async () => {
    const a = await actor("mint");
    const other = await actor("mint-other");
    const mine = await claim(a);
    await claim(other);
    if (!mine.claimed) throw new Error("claim failed");
    const wrote = await store.recordAuthorizationMint({
      actorId: a,
      createdAt: mine.attempt.createdAt,
      authId: "ar_abc",
    });
    expect(wrote).toBe(true);
    const got = await store.authorizationAttemptFor(a);
    expect(got?.authId).toBe("ar_abc");
    expect((await store.authorizationAttemptFor(other))?.authId).toBeNull();
  });

  test("a mint against a different created_at writes nothing", async () => {
    const a = await actor("mint-stale");
    await claim(a);
    const wrote = await store.recordAuthorizationMint({
      actorId: a,
      createdAt: new Date(0),
      authId: "ar_stale",
    });
    expect(wrote).toBe(false);
    expect((await store.authorizationAttemptFor(a))?.authId).toBeNull();
  });

  /**
   * The attempt's `auth_id` as the TABLE holds it. Not `authorizationAttemptFor`, which answers
   * null for a settled attempt and so could not see a settled row being rewritten.
   */
  const storedAuthId = async (actorId: string) => {
    const [row] = await database
      .select({ authId: pendingAuthorizations.authId })
      .from(pendingAuthorizations)
      .where(eq(pendingAuthorizations.actorId, actorId));
    if (!row) throw new Error(`no attempt for ${actorId}`);
    return row.authId;
  };

  /** Claim and mint one attempt, answering the `created_at` it is named by. */
  const minted = async (actorId: string, authId: string) => {
    const got = await claim(actorId);
    if (!got.claimed) throw new Error("claim failed");
    const wrote = await store.recordAuthorizationMint({
      actorId,
      createdAt: got.attempt.createdAt,
      authId,
    });
    if (!wrote) throw new Error("first mint failed");
    return got.attempt.createdAt;
  };

  test("a late mint cannot rewrite a COMPLETED attempt's auth_id to null", async () => {
    const a = await actor("mint-late-null");
    const createdAt = await minted(a, "ar_consented");
    await database.execute(
      sql`update pending_authorizations set completed_at = now(), outcome = 'completed' where actor_id = ${a}`,
    );
    const wrote = await store.recordAuthorizationMint({
      actorId: a,
      createdAt,
      authId: null,
    });
    expect(await storedAuthId(a)).toBe("ar_consented");
    expect(wrote).toBe(false);
  });

  test("a late mint cannot rebind a FAILED attempt to a different ar_", async () => {
    const a = await actor("mint-late-other");
    const createdAt = await minted(a, "ar_consented");
    expect(
      await store.failAuthorizationAttempt({
        actorId: a,
        authId: "ar_consented",
      }),
    ).toBe(true);
    const wrote = await store.recordAuthorizationMint({
      actorId: a,
      createdAt,
      authId: "ar_other",
    });
    expect(await storedAuthId(a)).toBe("ar_consented");
    expect(wrote).toBe(false);
  });

  test("a duplicated mint cannot rebind a LIVE attempt that already holds an ar_", async () => {
    const a = await actor("mint-dup");
    const createdAt = await minted(a, "ar_first");
    const wrote = await store.recordAuthorizationMint({
      actorId: a,
      createdAt,
      authId: "ar_second",
    });
    expect(await storedAuthId(a)).toBe("ar_first");
    expect(wrote).toBe(false);
  });

  test("a mint cannot bind an attempt settled with no auth_id by a writer outside the store", async () => {
    const a = await actor("mint-late-settled-null");
    const got = await claim(a);
    if (!got.claimed) throw new Error("claim failed");
    await database.execute(
      sql`update pending_authorizations set completed_at = now(), outcome = 'failed' where actor_id = ${a}`,
    );
    const wrote = await store.recordAuthorizationMint({
      actorId: a,
      createdAt: got.attempt.createdAt,
      authId: "ar_late",
    });
    expect(await storedAuthId(a)).toBeNull();
    expect(wrote).toBe(false);
  });

  test("a mint still writes onto a live attempt whose vendor answered no id", async () => {
    const a = await actor("mint-after-null");
    const got = await claim(a);
    if (!got.claimed) throw new Error("claim failed");
    expect(
      await store.recordAuthorizationMint({
        actorId: a,
        createdAt: got.attempt.createdAt,
        authId: null,
      }),
    ).toBe(true);
    expect(await storedAuthId(a)).toBeNull();
  });
});

describe("discardAuthorizationAttempt", () => {
  test("deletes the named attempt, an unminted one included", async () => {
    const a = await actor("discard");
    const got = await claim(a);
    if (!got.claimed) throw new Error("claim failed");
    const deleted = await store.discardAuthorizationAttempt({
      actorId: a,
      createdAt: got.attempt.createdAt,
    });
    expect(deleted).toBe(true);
    expect(await store.authorizationAttemptFor(a)).toBeNull();
  });

  test("leaves a NEWER attempt by the same actor standing", async () => {
    const a = await actor("newer");
    const older = await claim(a, "older");
    if (!older.claimed) throw new Error("claim failed");
    await age(a, "16 minutes");
    // What the row NOW holds, which is what a late discard would have been aiming at.
    // `older.attempt.createdAt` is the PRE-age value and matches nothing, so a discard
    // aimed at it misses whether or not a replacement exists, which is no test at all.
    const [aged] = await database
      .select()
      .from(pendingAuthorizations)
      .where(eq(pendingAuthorizations.actorId, a));
    if (!aged) throw new Error("aged row missing");
    const agedAt = aged.createdAt;

    const newer = await claim(a, "newer");
    expect(newer.claimed).toBe(true);
    if (!newer.claimed) return;
    // Differ by 16 minutes BY CONSTRUCTION, not by wall-clock luck: no same-millisecond race.
    expect(newer.attempt.createdAt.getTime()).not.toBe(agedAt.getTime());

    // Aimed at the attempt that actually stood: the replacement must survive it.
    const deleted = await store.discardAuthorizationAttempt({
      actorId: a,
      createdAt: agedAt,
    });
    expect(deleted).toBe(false);
    const standing = await store.authorizationAttemptFor(a);
    expect(standing?.action).toBe("newer");
    expect(standing?.createdAt.getTime()).toBe(
      newer.attempt.createdAt.getTime(),
    );
  });

  /*
   * B2a. A SETTLED ATTEMPT IS A RECORD, AND A DISCARD AIMED AT IT BY ITS OWN `created_at` MUST NOT
   * ERASE IT. Every caller reads the attempt first and discards it after, so the `created_at` it
   * holds still names the row once a completion has committed in between.
   */
  for (const outcome of [
    "completed",
    "failed",
    "unreconciled",
    "withdrawn",
  ] as const) {
    test(`leaves a ${outcome} attempt standing and answers false`, async () => {
      const a = await actor(`discard-settled-${outcome}`);
      const got = await claim(a);
      if (!got.claimed) throw new Error("claim failed");
      await database.execute(
        sql`update pending_authorizations set completed_at = now(), outcome = ${outcome} where actor_id = ${a}`,
      );

      const deleted = await store.discardAuthorizationAttempt({
        actorId: a,
        createdAt: got.attempt.createdAt,
      });

      const rows = await database
        .select()
        .from(pendingAuthorizations)
        .where(eq(pendingAuthorizations.actorId, a));
      expect(rows.map((row) => row.outcome)).toEqual([outcome]);
      expect(deleted).toBe(false);
      expect(
        await store.settledAuthorizationOutcome({
          actorId: a,
          createdAt: got.attempt.createdAt,
        }),
      ).toBe(outcome);
    });
  }
});

describe("authorizationAttemptFor", () => {
  test("answers the live attempt", async () => {
    const a = await actor("for-live");
    await claim(a);
    expect((await store.authorizationAttemptFor(a))?.actorId).toBe(a);
  });

  test("answers null when there is none", async () => {
    expect(
      await store.authorizationAttemptFor(await actor("for-none")),
    ).toBeNull();
  });

  test("answers null past the TTL", async () => {
    const a = await actor("for-expired");
    await claim(a);
    await age(a, "16 minutes");
    expect(await store.authorizationAttemptFor(a)).toBeNull();
  });
});

/**
 * Naming an attempt by its `created_at` has to work for a row ANY writer wrote, and for a value
 * that has been through JSON on the way back.
 *
 * `claimAuthorizationAttempt` truncates what it writes to milliseconds, but the COLUMN DEFAULT is
 * `now()`, which PostgreSQL keeps to the microsecond; a row that takes the default — which is what
 * drizzle's inferred insert type invites — is read back as a millisecond `Date` naming a different
 * instant than the one stored. An exact `=` then matches nothing and the attempt is silently dead:
 * no `auth_id` is ever written, and per the table's own docblock "an attempt holding null can never
 * complete".
 */
describe("naming an attempt by created_at", () => {
  /** Takes the column default, the way any writer using the inferred insert type does. */
  const insertWithDefaultCreatedAt = async (actorId: string) => {
    const [row] = await database
      .insert(pendingAuthorizations)
      .values({
        actorId,
        serverId,
        action: "connect",
        holder: "person",
        userId: actorId,
        vendorUserId: `v-${actorId}`,
      })
      .returning();
    if (!row) throw new Error("insert returned nothing");
    return row;
  };

  test("a mint matches a row written with the column default", async () => {
    const a = await actor("default-mint");
    const row = await insertWithDefaultCreatedAt(a);
    const wrote = await store.recordAuthorizationMint({
      actorId: a,
      createdAt: row.createdAt,
      authId: "ar_default",
    });
    expect(wrote).toBe(true);
    expect((await store.authorizationAttemptFor(a))?.authId).toBe("ar_default");
  });

  test("a discard matches a row written with the column default", async () => {
    const a = await actor("default-discard");
    const row = await insertWithDefaultCreatedAt(a);
    expect(
      await store.discardAuthorizationAttempt({
        actorId: a,
        createdAt: row.createdAt,
      }),
    ).toBe(true);
    expect(await store.authorizationAttemptFor(a)).toBeNull();
  });

  test("a created_at that has been through JSON still names its attempt", async () => {
    const a = await actor("json-mint");
    const got = await claim(a);
    if (!got.claimed) throw new Error("claim failed");
    // The declared type says `Date`; a serialised attempt hands back a string.
    const serialised: { createdAt: Date } = JSON.parse(
      JSON.stringify(got.attempt),
    );
    const wrote = await store.recordAuthorizationMint({
      actorId: a,
      createdAt: serialised.createdAt,
      authId: "ar_json",
    });
    expect(wrote).toBe(true);
    expect((await store.authorizationAttemptFor(a))?.authId).toBe("ar_json");
  });

  test("a created_at that names no instant is refused, not matched", async () => {
    const a = await actor("bad-instant");
    await claim(a);
    await expect(
      store.recordAuthorizationMint({
        actorId: a,
        createdAt: new Date("not a date"),
        authId: "ar_bad",
      }),
    ).rejects.toThrow(/created_at/);
    expect((await store.authorizationAttemptFor(a))?.authId).toBeNull();
  });
});
