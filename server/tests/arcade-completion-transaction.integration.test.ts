// server/tests/arcade-completion-transaction.integration.test.ts
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, like } from "drizzle-orm";
import { createAuditStore } from "../src/audit";
import { createDatabase } from "../src/db/client";
import {
  auditEvents,
  brokeredConnections,
  mcpServers,
  pendingAuthorizations,
} from "../src/db/schema";
import type { ConnectedAppBroker } from "../src/plugins/broker";
import type { AccountRef } from "../src/plugins/shared-accounts";
import { createPluginStore } from "../src/plugins/store";
import { testDatabaseUrl } from "./support/database";
import { removePeople, seedPeople } from "./support/people";

/*
 * FOUR CONNECTIONS RATHER THAN THE SHARED `TEST_POOL` OF TWO, because the race below drives two
 * completion TRANSACTIONS at once and the second one blocks on the first's row lock while holding
 * its own connection. Two is the exact floor for that pair and leaves nothing for the reads that
 * follow if the driver has not handed a connection back yet; `support/database.ts` says a file
 * wanting a different pool asks for one itself.
 */
const database = createDatabase(testDatabaseUrl(), { max: 4 });
const suite = randomUUID().slice(0, 8);
const serverId = `arcade-completion-${suite}`;

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

const storeOn = (handle: typeof database) =>
  createPluginStore({
    brokerProvider: "arcade",
    database: handle,
    auditStore: createAuditStore(handle),
    credentials: {} as never,
    encryptionKey: "x".repeat(44),
    policy: () => policy,
    broker,
    deploymentId: `acme-${suite}`,
    sharedUse: async () => ({ allowed: true }),
  });

const store = storeOn(database);

/**
 * The same store with the AUDIT INSERT made to throw, and nothing else changed.
 *
 * The failure is injected at the DATABASE HANDLE rather than at the store's `auditStore` option,
 * because the audit write that has to be atomic with the connection write is the one bound to the
 * transaction — a throwing `auditStore` passed into `createPluginStore` would never be the object
 * that write goes through, and the test would prove nothing. This proxy lets the connection upsert
 * through and refuses the `audit_events` insert, so it fires BETWEEN the two writes, which is where
 * the rollback has to hold.
 */
const brokenAuditDatabase = new Proxy(database, {
  get(target, property, receiver) {
    if (property !== "transaction") {
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    }
    return (work: (tx: unknown) => Promise<unknown>) =>
      target.transaction((transaction) =>
        work(
          new Proxy(transaction, {
            get(txTarget, txProperty, txReceiver) {
              if (txProperty === "insert") {
                return (table: unknown) => {
                  if (table === auditEvents)
                    throw new Error("injected audit failure");
                  return txTarget.insert(table as never);
                };
              }
              const value = Reflect.get(txTarget, txProperty, txReceiver);
              return typeof value === "function" ? value.bind(txTarget) : value;
            },
          }),
        ),
      );
  },
}) as typeof database;

const brokenAuditStore = storeOn(brokenAuditDatabase);

const account = (actor: string): AccountRef => ({
  holder: "person",
  userId: actor,
  vendorUserId: `v-${actor}`,
});

/**
 * An actor id for this suite, AND THE PERSON BEHIND IT.
 *
 * `pending_authorizations.actor_id` keys to `users` and cascades (`.user_id` must equal it), so an
 * attempt cannot exist for somebody who does not. Seeded here so each case stays about the completion transaction
 * rather than about the foreign key.
 */
const people: string[] = [];
const actor = async (name: string) => {
  const id = `${name}-${suite}`;
  people.push(id);
  await seedPeople(database, [id]);
  return id;
};
const toolkit = (name: string) => `tk-${name}-${suite}`;

/** A claimed attempt carrying a minted `ar_...`, which is what a callback arrives against. */
const attemptWith = async (actorId: string, authId: string) => {
  const claimed = await store.claimAuthorizationAttempt({
    actorId,
    serverId,
    action: "Google.SendEmail",
    account: account(actorId),
  });
  if (!claimed.claimed) throw new Error("claim failed");
  const minted = await store.recordAuthorizationMint({
    actorId,
    createdAt: claimed.attempt.createdAt,
    authId,
  });
  if (!minted) throw new Error("mint failed");
  return claimed.attempt;
};

const connectionsFor = (app: string) =>
  database
    .select()
    .from(brokeredConnections)
    .where(
      and(
        eq(brokeredConnections.provider, "arcade"),
        eq(brokeredConnections.app, app),
      ),
    );

const connectedEventsFor = (app: string) =>
  database
    .select()
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.eventType, "mcp.account_connected"),
        eq(auditEvents.targetId, app),
      ),
    );

const attemptRow = async (actorId: string) => {
  const [row] = await database
    .select()
    .from(pendingAuthorizations)
    .where(eq(pendingAuthorizations.actorId, actorId));
  if (!row) throw new Error("attempt row gone");
  return row;
};

beforeAll(async () => {
  await database.insert(mcpServers).values({
    id: serverId,
    title: "Completion transaction",
    vendor: "Arcade",
    url: "https://example.invalid/mcp",
  });
});

afterAll(async () => {
  // Cascades to the attempts. The connections are keyed on the app, not the server, so they go
  // separately; the audit rows cannot go at all, which is what `audit_events_append_only` is for.
  await database.delete(mcpServers).where(eq(mcpServers.id, serverId));
  await database
    .delete(brokeredConnections)
    .where(like(brokeredConnections.app, `%-${suite}`));
  await removePeople(database, people);
  await database.$client.close();
});

describe("completeAuthorizationAttempt", () => {
  test("one call writes exactly one connection and one audit event naming the action and scopes", async () => {
    const a = await actor("single");
    const app = toolkit("single");
    await attemptWith(a, "ar_single");

    await store.completeAuthorizationAttempt({
      actorId: a,
      authId: "ar_single",
      toolkit: app,
      account: account(a),
      action: "Google.SendEmail",
      scopes: ["gmail.send", "gmail.readonly"],
      authProvider: "google",
    });

    const connections = await connectionsFor(app);
    expect(connections.length).toBe(1);
    expect(connections[0]?.holder).toBe("person");
    expect(connections[0]?.userId).toBe(a);
    expect(connections[0]?.vendorUserId).toBe(`v-${a}`);
    expect(connections[0]?.verified).toBe(true);
    expect(connections[0]?.verifiedAt).not.toBeNull();
    expect(connections[0]?.probeAction).toBeNull();
    // A PERSON'S ROW IS ATTRIBUTED BY `user_id` AND NEVER BY `connected_by`, which is the
    // deployment-held column: `deploymentConnectionFor` is the only reader and it reads only
    // `holder = 'deployment'`. Writing the actor here would put an id in a column no reader of a
    // person's row consults, on the row that already names them.
    expect(connections[0]?.connectedBy).toBeNull();

    const events = await connectedEventsFor(app);
    expect(events.length).toBe(1);
    const payload = events[0]?.payload as Record<string, unknown>;
    expect(payload.action).toBe("Google.SendEmail");
    expect(payload.scope).toBe("gmail.send gmail.readonly");
    expect(payload.server).toBe(app);
    expect(payload.holder).toBe("person");
    expect(payload.authProvider).toBe("google");
    expect(payload).not.toHaveProperty("provider");

    const attempt = await attemptRow(a);
    expect(attempt.outcome).toBe("completed");
    expect(attempt.completedAt).not.toBeNull();
  });

  /*
   * WHO CONNECTED THE TEAM ACCOUNT. A Shared app's row is the one place an administrator can read
   * that from, and a consent completed through Arcade used to leave it permanently null — so
   * `deploymentConnectionFor` answered that nobody connected an account the whole deployment acts
   * as. The actor is the session subject (`users.id`) the attempt is keyed on, which is the id the
   * admin read joins `users` on for an email.
   */
  test("a DEPLOYMENT-held completion records the administrator who consented, and a later one supersedes", async () => {
    const first = await actor("shared-first");
    const second = await actor("shared-second");
    const app = toolkit("shared");
    const deployment: AccountRef = {
      holder: "deployment",
      vendorUserId: `v-${app}`,
    };

    const claimFor = async (actorId: string, authId: string) => {
      const claimed = await store.claimAuthorizationAttempt({
        actorId,
        serverId,
        action: "Google.SendEmail",
        account: deployment,
      });
      if (!claimed.claimed) throw new Error("claim failed");
      const minted = await store.recordAuthorizationMint({
        actorId,
        createdAt: claimed.attempt.createdAt,
        authId,
      });
      if (!minted) throw new Error("mint failed");
    };
    const complete = (actorId: string, authId: string) =>
      store.completeAuthorizationAttempt({
        actorId,
        authId,
        toolkit: app,
        account: deployment,
        action: "Google.SendEmail",
        scopes: ["gmail.send"],
        authProvider: "google",
      });

    await claimFor(first, "ar_shared_first");
    await complete(first, "ar_shared_first");

    let connections = await connectionsFor(app);
    expect(connections.length).toBe(1);
    expect(connections[0]?.holder).toBe("deployment");
    expect(connections[0]?.userId).toBeNull();
    expect(connections[0]?.connectedBy).toBe(first);

    // AND THE SECOND ADMINISTRATOR SUPERSEDES THE FIRST, because a deployment account is shared
    // and the row credits whoever most recently consented for it. The insert takes the conflict
    // branch here, which is the half that used to keep an attribution standing while rewriting
    // everything around it.
    await claimFor(second, "ar_shared_second");
    await complete(second, "ar_shared_second");

    connections = await connectionsFor(app);
    expect(connections.length).toBe(1);
    expect(connections[0]?.connectedBy).toBe(second);
  });

  /*
   * THE ROW NAMES THE IDENTITY THE LATEST CONSENT WAS GIVEN UNDER. Calls go out under the row's
   * `vendor_user_id` (`connectionTokenFor` reads it back rather than recomputing it), so a
   * re-consent under a new identity that rewrote `verified`/`verified_at` and left the old id
   * standing sent every later call to an account this consent says nothing about. Both holders,
   * because both conflict arms used to omit it.
   */
  test.each(["deployment", "person"] as const)(
    "a %s re-consent under a NEW vendor identity moves the row to it",
    async (holder) => {
      const a = await actor(`reid-${holder}`);
      const app = toolkit(`reid-${holder}`);
      const as = (vendorUserId: string): AccountRef =>
        holder === "deployment"
          ? { holder, vendorUserId }
          : { holder, userId: a, vendorUserId };

      const consent = async (authId: string, ref: AccountRef) => {
        const claimed = await store.claimAuthorizationAttempt({
          actorId: a,
          serverId,
          action: "Google.SendEmail",
          account: ref,
        });
        if (!claimed.claimed) throw new Error("claim failed");
        const minted = await store.recordAuthorizationMint({
          actorId: a,
          createdAt: claimed.attempt.createdAt,
          authId,
        });
        if (!minted) throw new Error("mint failed");
        await store.completeAuthorizationAttempt({
          actorId: a,
          authId,
          toolkit: app,
          account: ref,
          action: "Google.SendEmail",
          scopes: ["gmail.send"],
          authProvider: "google",
        });
      };

      await consent(`ar_reid_${holder}_1`, as(`old-${app}`));
      await consent(`ar_reid_${holder}_2`, as(`new-${app}`));

      const connections = await connectionsFor(app);
      expect(connections.length).toBe(1);
      expect(connections[0]?.vendorUserId).toBe(`new-${app}`);
    },
  );

  test("two CONCURRENT calls write exactly one connection and one audit event, and only the winner says it claimed the row", async () => {
    const a = await actor("race");
    const app = toolkit("race");
    await attemptWith(a, "ar_race");

    const call = () =>
      store.completeAuthorizationAttempt({
        actorId: a,
        authId: "ar_race",
        toolkit: app,
        account: account(a),
        action: "Google.SendEmail",
        scopes: ["gmail.send"],
        authProvider: "google",
      });

    // CONCURRENTLY, on the real pool. A sequential replay passes against an implementation with no
    // serialization at all, so it would be no evidence about this method.
    const answers = await Promise.all([call(), call()]);
    // Neither throws — a replay is a no-op and not an error — but the loser SAYS it claimed nothing,
    // so a caller can tell a rival's completion from its own and ask the row which it was.
    expect(answers.map((answer) => answer.claimed).sort()).toEqual([
      false,
      true,
    ]);

    expect((await connectionsFor(app)).length).toBe(1);
    expect((await connectedEventsFor(app)).length).toBe(1);

    const attempt = await attemptRow(a);
    expect(attempt.outcome).toBe("completed");
    expect(attempt.completedAt).not.toBeNull();
  });

  test("a failure between the connection write and the audit write persists NEITHER", async () => {
    const a = await actor("rollback");
    const app = toolkit("rollback");
    await attemptWith(a, "ar_rollback");

    await expect(
      brokenAuditStore.completeAuthorizationAttempt({
        actorId: a,
        authId: "ar_rollback",
        toolkit: app,
        account: account(a),
        action: "Google.SendEmail",
        scopes: ["gmail.send"],
        authProvider: "google",
      }),
    ).rejects.toThrow("injected audit failure");

    // BOTH tables, because "it returned" is not evidence that nothing was written.
    expect((await connectionsFor(app)).length).toBe(0);
    expect((await connectedEventsFor(app)).length).toBe(0);

    // And the attempt is still claimable, because its UPDATE was in the same transaction.
    const attempt = await attemptRow(a);
    expect(attempt.completedAt).toBeNull();
    expect(attempt.outcome).toBeNull();
  });

  test("an auth_id that does not match the row writes nothing and leaves the row UNCHANGED", async () => {
    const a = await actor("mismatch");
    const app = toolkit("mismatch");
    await attemptWith(a, "ar_real");

    await store.completeAuthorizationAttempt({
      actorId: a,
      authId: "ar_someone_elses",
      toolkit: app,
      account: account(a),
      action: "Google.SendEmail",
      scopes: ["gmail.send"],
      authProvider: "google",
    });

    expect((await connectionsFor(app)).length).toBe(0);
    expect((await connectedEventsFor(app)).length).toBe(0);

    // THE ROW'S OWN STATE, not a return value.
    const attempt = await attemptRow(a);
    expect(attempt.completedAt).toBeNull();
    expect(attempt.outcome).toBeNull();
    expect(attempt.authId).toBe("ar_real");
  });
});

describe("failAuthorizationAttempt / markAuthorizationUnreconciled", () => {
  test("mark an attempt failed, matched on (actor_id, auth_id)", async () => {
    const a = await actor("failed");
    await attemptWith(a, "ar_failed");

    expect(
      await store.failAuthorizationAttempt({
        actorId: a,
        authId: "ar_other",
      }),
    ).toBe(false);
    let attempt = await attemptRow(a);
    expect(attempt.outcome).toBeNull();
    expect(attempt.completedAt).toBeNull();

    expect(
      await store.failAuthorizationAttempt({ actorId: a, authId: "ar_failed" }),
    ).toBe(true);
    attempt = await attemptRow(a);
    expect(attempt.outcome).toBe("failed");
    expect(attempt.completedAt).not.toBeNull();
  });

  test("mark an attempt unreconciled, matched on (actor_id, auth_id)", async () => {
    const a = await actor("unreconciled");
    await attemptWith(a, "ar_unreconciled");

    expect(
      await store.markAuthorizationUnreconciled({
        actorId: a,
        authId: "ar_other",
      }),
    ).toBe(false);
    expect((await attemptRow(a)).outcome).toBeNull();

    expect(
      await store.markAuthorizationUnreconciled({
        actorId: a,
        authId: "ar_unreconciled",
      }),
    ).toBe(true);
    const attempt = await attemptRow(a);
    expect(attempt.outcome).toBe("unreconciled");
    expect(attempt.completedAt).not.toBeNull();
  });

  /*
   * THE CASE THE `(actor_id, auth_id)` MATCH DOES NOT EXCLUDE ON ITS OWN. A completed attempt is
   * still holding the `ar_...` the failing leg matches on, so without `completed_at IS NULL` this
   * close rewrote a person's SUCCESSFUL authorization as a failure — while the connection row and
   * the `mcp.account_connected` entry written by that completion stood. The attempt and the trail
   * then disagreed, and the attempt was the one that was wrong.
   *
   * Sequential rather than concurrent, deliberately, and it is not a weaker test: the failing leg
   * is a LATE callback and the thing under test is the state of the committed row it arrives at,
   * not a lock ordering. Concurrency is what `completeAuthorizationAttempt`'s own race test proves.
   */
  test("a late failure callback does NOT reopen an attempt that already completed", async () => {
    const a = await actor("late-fail");
    const app = toolkit("late-fail");
    await attemptWith(a, "ar_late_fail");

    await store.completeAuthorizationAttempt({
      actorId: a,
      authId: "ar_late_fail",
      toolkit: app,
      account: account(a),
      action: "Google.SendEmail",
      scopes: ["gmail.send"],
      authProvider: "google",
    });
    const completed = await attemptRow(a);
    expect(completed.outcome).toBe("completed");

    /*
     * THE ROW IS ASSERTED BEFORE THE RETURN VALUE, so a regression here reads as the corruption it
     * is rather than as a boolean that came back the wrong way. The boolean is checked too, below.
     */
    const closed = await store.failAuthorizationAttempt({
      actorId: a,
      authId: "ar_late_fail",
    });

    const after = await attemptRow(a);
    expect(after.outcome).toBe("completed");
    // NOT MERELY "still terminal": the timestamp must be the completion's own, because re-stamping
    // it would move when this grant was obtained even where the verdict survived.
    expect(after.completedAt).toEqual(completed.completedAt);
    // The grant the attempt is the record OF is untouched, which is the half a reader checks next.
    expect((await connectionsFor(app)).length).toBe(1);
    expect((await connectedEventsFor(app)).length).toBe(1);
    expect(closed).toBe(false);
  });

  /* The same rule among the three non-completion verdicts: the first one to settle the row wins. */
  test("a second verdict does not overwrite the first one an attempt settled on", async () => {
    const a = await actor("settled");
    await attemptWith(a, "ar_settled");

    expect(
      await store.failAuthorizationAttempt({
        actorId: a,
        authId: "ar_settled",
      }),
    ).toBe(true);
    const failed = await attemptRow(a);

    const withdrew = await store.markAuthorizationWithdrawn({
      actorId: a,
      authId: "ar_settled",
    });
    const unreconciled = await store.markAuthorizationUnreconciled({
      actorId: a,
      authId: "ar_settled",
    });

    const after = await attemptRow(a);
    expect(after.outcome).toBe("failed");
    expect(after.completedAt).toEqual(failed.completedAt);
    expect([withdrew, unreconciled]).toEqual([false, false]);
  });
});
