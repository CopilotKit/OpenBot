// server/tests/arcade-siblings.test.ts
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import { createAuditStore } from "../src/audit";
import { createDatabase } from "../src/db/client";
import { brokeredConnections } from "../src/db/schema";
import type { ConnectedAppBroker } from "../src/plugins/broker";
import { createComposioClient } from "../src/plugins/composio-adapter";
import { mintDeploymentVendorUserId } from "../src/plugins/shared-accounts";
import { connectionSiblings, createPluginStore } from "../src/plugins/store";
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
const lonely = `Lonely-${suite}`;

// Which vendor auth provider each app's connection is held under, as the adapter reads it off the
// vendor's own listing. Gmail and Calendar are Google; Slack is Slack — and NONE of them is named
// after its toolkit, which is the fact the resolver must not be able to guess its way around.
const providerOf: Record<string, string> = {
  [gmail]: "google",
  [calendar]: "google",
  [slack]: "slack",
  [lonely]: "google",
};
/** Every toolkit the store asked about, in order. The pre-filter is what this pins. */
const asked: string[] = [];

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
  authProviderOf: async (toolkit) => {
    asked.push(toolkit);
    return providerOf[toolkit] ?? null;
  },
  grantsFor: async () => [],
  listApps: async () => [],
  ensureAuthConfig: async () => "standing",
  deleteAuthConfig: async () => {},
  authorize: async () => ({
    redirectUrl: "https://vendor.example/consent",
    authorizationId: "ar_1",
  }),
  isConnected: async () => true,
  revoke: async () => true,
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
async function holdShared(app: string, vendorUserId: string) {
  seeded.push(app);
  await database.insert(brokeredConnections).values({
    provider: "arcade",
    app,
    holder: "deployment",
    vendorUserId,
  });
}
async function holdPersonal(app: string, userId: string) {
  seeded.push(app);
  await database.insert(brokeredConnections).values({
    provider: "arcade",
    app,
    holder: "person",
    userId,
    vendorUserId: userId,
  });
}

afterEach(async () => {
  if (seeded.length)
    await database
      .delete(brokeredConnections)
      .where(inArray(brokeredConnections.app, seeded));
  seeded.length = 0;
  asked.length = 0;
});

/**
 * THE PAIR, ASSERTED ON THE PURE FUNCTION, WHICH IS WHERE IT IS NOW THE ONLY THING ASSERTING IT.
 *
 * `siblingApps` pre-filters its scan on the asking identity in SQL, so a footprint on another
 * identity never reaches `connectionSiblings` through that door any more and a store-level test can
 * no longer tell the identity check from the `WHERE`. The rule itself has not moved — the apps that
 * share a connection are the apps sharing BOTH the vendor identity and the auth provider — so the
 * proof moves here, where deleting the `vendorUserId` equality reddens it.
 */
describe("connectionSiblings keys on the pair and never the provider alone", () => {
  test("two shared Google apps with different minted identities are not siblings", () => {
    const gmailIdentity = mintDeploymentVendorUserId(`acme-${suite}`);
    const calendarIdentity = mintDeploymentVendorUserId(`acme-${suite}`);
    expect(gmailIdentity).not.toBe(calendarIdentity);

    expect(
      connectionSiblings(
        { app: gmail, vendorUserId: gmailIdentity, authProvider: "google" },
        [
          { app: gmail, vendorUserId: gmailIdentity, authProvider: "google" },
          {
            app: calendar,
            vendorUserId: calendarIdentity,
            authProvider: "google",
          },
        ],
      ),
    ).toEqual([]);
  });

  test("one identity on one provider is siblings, case-folded on the provider alone", () => {
    expect(
      connectionSiblings(
        { app: gmail, vendorUserId: "u", authProvider: "google" },
        [
          { app: calendar, vendorUserId: "u", authProvider: "GOOGLE" },
          { app: slack, vendorUserId: "u", authProvider: "slack" },
        ],
      ),
    ).toEqual([calendar]);
  });
});

describe("revocation siblings are keyed on (vendor identity, auth provider)", () => {
  test("two Shared apps on the same provider with DIFFERENT minted identities are not siblings", async () => {
    const gmailIdentity = mintDeploymentVendorUserId(`acme-${suite}`);
    const calendarIdentity = mintDeploymentVendorUserId(`acme-${suite}`);
    expect(gmailIdentity).not.toBe(calendarIdentity);
    await holdShared(gmail, gmailIdentity);
    await holdShared(calendar, calendarIdentity);

    expect(
      await store.siblingApps({
        toolkit: gmail,
        account: { holder: "deployment", vendorUserId: gmailIdentity },
      }),
    ).toEqual({ siblings: [], unanswered: 0 });
  });

  test("two apps genuinely sharing the pair are siblings, and an app on another provider is not", async () => {
    const userId = `person-${suite}`;
    await holdPersonal(gmail, userId);
    await holdPersonal(calendar, userId);
    await holdPersonal(slack, userId);

    expect(
      await store.siblingApps({
        toolkit: gmail,
        account: { holder: "person", userId, vendorUserId: userId },
      }),
    ).toEqual({ siblings: [calendar], unanswered: 0 });
  });

  test("an app with no co-tenant has an empty list, never itself", async () => {
    const userId = `solo-${suite}`;
    await holdPersonal(lonely, userId);

    expect(
      await store.siblingApps({
        toolkit: lonely,
        account: { holder: "person", userId, vendorUserId: userId },
      }),
    ).toEqual({ siblings: [], unanswered: 0 });
  });

  /**
   * THE PRE-FILTER, AND A CALL COUNT IS THE ONLY THING THAT PINS IT. Resolving the auth provider is
   * a VENDOR CALL per app, made on a screen somebody is waiting on (the Disconnect confirmation),
   * and a scan that resolved every brokered row of the deployment and only then discarded the rows
   * on other identities would be unbounded in the one dimension that grows. The answer is identical
   * either way — `connectionSiblings` discards exactly those rows — so nothing but the count can
   * tell the two implementations apart.
   */
  test("resolves the auth provider ONLY for rows on the asking identity", async () => {
    const mine = `mine-${suite}`;
    const theirs = `theirs-${suite}`;
    await holdPersonal(gmail, mine);
    await holdPersonal(calendar, mine);
    await holdPersonal(slack, theirs);
    await holdShared(lonely, mintDeploymentVendorUserId(`acme-${suite}`));

    expect(
      await store.siblingApps({
        toolkit: gmail,
        account: { holder: "person", userId: mine, vendorUserId: mine },
      }),
    ).toEqual({ siblings: [calendar], unanswered: 0 });

    // The asking toolkit, plus its own two rows. Never `slack`, never `lonely`.
    expect(asked.toSorted()).toEqual([calendar, gmail, gmail].toSorted());
  });
});

/**
 * COMPOSIO'S EMPTY ANSWER IS THE TRUTH ABOUT COMPOSIO. Its connections are per auth config and an
 * auth config is per toolkit, so each app is its own auth provider and no two apps ever share one
 * connection — however many apps one identity holds. Asserted through the store rather than only
 * on the broker, because the empty list is what a disconnect screen will render.
 */
describe("siblingApps under Composio", () => {
  const composioStore = createPluginStore({
    brokerProvider: "composio",
    database,
    auditStore: createAuditStore(database),
    credentials: {} as never,
    encryptionKey: "x".repeat(44),
    policy: () => ({ mode: "enforce" as const, deny: [], allow: ["true"] }),
    broker: createComposioClient("never-dialled").broker,
  });

  test("an identity holding several apps has no siblings at any of them", async () => {
    const userId = `composio-${suite}`;
    for (const app of [gmail, calendar, slack]) {
      seeded.push(app);
      await database.insert(brokeredConnections).values({
        provider: "composio",
        app,
        holder: "person",
        userId,
        vendorUserId: userId,
      });
    }

    expect(
      await composioStore.siblingApps({
        toolkit: gmail,
        account: { holder: "person", userId, vendorUserId: userId },
      }),
    ).toEqual({ siblings: [], unanswered: 0 });
  });
});
