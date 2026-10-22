// server/tests/arcade-sibling-collateral.test.ts
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { createAuditStore } from "../src/audit";
import { createDatabase } from "../src/db/client";
import { auditEvents, brokeredConnections, mcpServers } from "../src/db/schema";
import { createAccountModeSwitch } from "../src/plugins/account-mode";
import type { ConnectedAppBroker } from "../src/plugins/broker";
import { createSharedUseStore } from "../src/plugins/shared-use-store";
import { createPluginStore } from "../src/plugins/store";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/*
 * SCOPING. `audit_events` is append-only and `brokered_connections` is long-lived, so every
 * assertion here is keyed on names THIS TEST ALONE writes: each test mints its own `run()` — a
 * fresh suffix on every app and every vendor identity it touches — and reads rows and the trail
 * only by those. A "did not happen" assertion is therefore one only this test could have falsified.
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);

/* The pool this file opened, given back. `bun test` runs every file in one process and nothing
 * reaps an idle connection, so a pool held to the end of the run is two connections the rest of
 * the suite cannot have. */
afterAll(async () => {
  await database.$client.close();
});
const suite = randomUUID().slice(0, 8);

const providerOf = (toolkit: string) =>
  toolkit.startsWith("Slack-") ? "slack" : "google";

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
  authProviderOf: async (toolkit) => providerOf(toolkit),
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
  deploymentId: "acme",
  sharedUse: async () => ({ allowed: true }),
});
const modes = createAccountModeSwitch({
  store,
  sharedUse: createSharedUseStore(database, "arcade"),
  deploymentId: "acme",
  audit: createAuditStore(database),
  teamRules: undefined,
});

const apps: string[] = [];
let n = 0;
/** This test's own names: nothing another test writes can share one. */
function run() {
  n += 1;
  const tag = `${suite}${n}`;
  const names = {
    gmail: `Gmail-${tag}`,
    calendar: `GoogleCalendar-${tag}`,
    slack: `Slack-${tag}`,
    person: `person-${tag}`,
  };
  apps.push(names.gmail, names.calendar, names.slack);
  return names;
}
async function server(
  app: string,
  mode: "personal" | "shared",
  authScheme = "OAUTH2",
) {
  await database.insert(mcpServers).values({
    id: app,
    title: app,
    vendor: "Arcade",
    url: `arcade://${app}`,
    provenance: "arcade",
    authScheme,
    accountMode: mode,
  });
}
async function hold(
  app: string,
  vendorUserId: string,
  holder: "person" | "deployment" = "person",
) {
  await database.insert(brokeredConnections).values({
    provider: "arcade",
    app,
    holder,
    userId: holder === "person" ? vendorUserId : null,
    vendorUserId,
  });
}
const rowsFor = async (names: string[]) =>
  (
    await database
      .select({ app: brokeredConnections.app })
      .from(brokeredConnections)
      .where(inArray(brokeredConnections.app, names))
      .orderBy(asc(brokeredConnections.app))
  ).map((row) => row.app);
const trailFor = (names: string[]) =>
  database
    .select({
      app: auditEvents.targetId,
      payload: sql<Record<string, unknown>>`payload`,
    })
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.eventType, "mcp.account_disconnected"),
        inArray(auditEvents.targetId, names),
      ),
    )
    .orderBy(asc(auditEvents.targetId));

afterEach(async () => {
  if (apps.length) {
    await database
      .delete(brokeredConnections)
      .where(inArray(brokeredConnections.app, apps));
    await database.delete(mcpServers).where(inArray(mcpServers.id, apps));
  }
  apps.length = 0;
});

describe("the Personal to Shared switch", () => {
  test("ends a sibling app's connection too, and removes and audits its row", async () => {
    const t = run();
    await server(t.gmail, "personal");
    await hold(t.gmail, t.person);
    await hold(t.calendar, t.person); // same identity, same provider: ended with Gmail
    await hold(t.slack, t.person); // another provider: not touched

    const result = await modes.switchMode({
      serverId: t.gmail,
      mode: "shared",
      by: "admin",
      confirm: true,
    });

    expect(result).toEqual({ changed: true, revoked: 1 });
    expect(await rowsFor([t.gmail, t.calendar, t.slack])).toEqual([t.slack]);
    const trail = await trailFor([t.gmail, t.calendar, t.slack]);
    expect(trail.map((event) => event.app)).toEqual(
      [t.calendar, t.gmail].sort(),
    );
    const sibling = trail.find((event) => event.app === t.calendar);
    expect(sibling?.payload).toMatchObject({
      reason: "mode_switched",
      endedWith: t.gmail,
      owner: t.person,
    });
  });

  test("a Shared app's switch back leaves another Shared app on the same provider alone", async () => {
    const t = run();
    await server(t.gmail, "shared");
    // Two Shared apps, one provider, but each its OWN minted identity: no shared connection.
    await hold(t.gmail, `deployment-${t.gmail}`, "deployment");
    await hold(t.calendar, `deployment-${t.calendar}`, "deployment");

    const result = await modes.switchMode({
      serverId: t.gmail,
      mode: "personal",
      by: "admin",
      confirm: true,
    });

    expect(result).toEqual({ changed: true, revoked: 1 });
    expect(await rowsFor([t.gmail, t.calendar])).toEqual([t.calendar]);
    expect((await trailFor([t.gmail, t.calendar])).map((e) => e.app)).toEqual([
      t.gmail,
    ]);
  });
});

describe("removing an app", () => {
  test("ends a sibling app's connection too, and removes and audits its row", async () => {
    const t = run();
    await server(t.gmail, "personal");
    await hold(t.gmail, t.person);
    await hold(t.calendar, t.person);
    await hold(t.slack, t.person);

    await store.removeServer(t.gmail, "admin");

    expect(await rowsFor([t.gmail, t.calendar, t.slack])).toEqual([t.slack]);
    const trail = await trailFor([t.gmail, t.calendar, t.slack]);
    expect(trail.map((event) => event.app)).toEqual(
      [t.calendar, t.gmail].sort(),
    );
    const sibling = trail.find((event) => event.app === t.calendar);
    expect(sibling?.payload).toMatchObject({
      reason: "mcp_server_removed",
      endedWith: t.gmail,
      owner: t.person,
      unansweredSiblings: 0,
    });
  });

  /*
   * THE BOUND, AND THE ONLY WAY IT IS VISIBLE. `authProviderOf` is a live `tools.list` per call on
   * Arcade and free on Composio (`async (toolkit) => toolkit`), so no behavioural assertion on
   * either provider can show the removal asking for it once per PERSON. Counting the calls on a
   * stub can: four people holding the same three apps is sixteen resolutions unmemoized, and the
   * memo threaded through this one removal brings it to one per DISTINCT TOOLKIT.
   */
  test("resolves each toolkit's auth provider once for the whole removal, not once per person", async () => {
    const t = run();
    const people = [1, 2, 3, 4].map((i) => `${t.person}-${i}`);
    await server(t.gmail, "personal");
    for (const person of people) {
      await hold(t.gmail, person);
      await hold(t.calendar, person);
      await hold(t.slack, person);
    }
    const asked: string[] = [];
    const counting: ConnectedAppBroker = {
      ...broker,
      authProviderOf: async (toolkit) => {
        asked.push(toolkit);
        return providerOf(toolkit);
      },
    };
    const countingStore = createPluginStore({
      brokerProvider: "arcade",
      database,
      auditStore: createAuditStore(database),
      credentials: {} as never,
      encryptionKey: "x".repeat(44),
      policy: () => ({ mode: "enforce" as const, deny: [], allow: ["true"] }),
      broker: counting,
      deploymentId: "acme",
      sharedUse: async () => ({ allowed: true }),
    });

    await countingStore.removeServer(t.gmail, "admin");

    // One ask per distinct toolkit across the rows walked — three — however many people hold them.
    expect([...new Set(asked)].sort()).toEqual(
      [t.calendar, t.gmail, t.slack].sort(),
    );
    expect(asked.length).toBe(3);
    // And the removal itself is unchanged: every person's Gmail and Calendar gone, Slack standing.
    expect(await rowsFor([t.gmail, t.calendar, t.slack])).toEqual(
      people.map(() => t.slack),
    );
  });

  test("a revoke that answers false does not delete or audit a sibling as ended", async () => {
    const t = run();
    await server(t.gmail, "personal");
    await hold(t.gmail, t.person);
    await hold(t.calendar, t.person);
    const unresolved: ConnectedAppBroker = {
      ...broker,
      revoke: async () => false,
    };
    const falseStore = createPluginStore({
      brokerProvider: "arcade",
      database,
      auditStore: createAuditStore(database),
      credentials: {} as never,
      encryptionKey: "x".repeat(44),
      policy: () => ({ mode: "enforce" as const, deny: [], allow: ["true"] }),
      broker: unresolved,
      deploymentId: "acme",
      sharedUse: async () => ({ allowed: true }),
    });

    await falseStore.removeServer(t.gmail, "admin");

    // The vendor was not shown to have ended Calendar: its row stands and nothing claims it ended.
    expect(await rowsFor([t.gmail, t.calendar])).toEqual([t.calendar]);
    const trail = await trailFor([t.gmail, t.calendar]);
    expect(trail.map((event) => event.app)).toEqual([t.gmail]);
    expect(trail[0]?.payload).toMatchObject({
      vendorRevocationRequested: false,
    });
  });

  /*
   * RULE 1 OF `clearEndedSiblings`, on the third act that cascades. Calendar shares Gmail's identity
   * and auth provider, so `resolveSiblings` names it — but this deployment holds a KEY for it, and
   * the one OAuth revoke a removal asks for never ended a key. Its row is the only way left to
   * reach that live account, so it stands, and the trail claims nothing about it.
   */
  test("a KEY sibling's row SURVIVES the removal, and nothing is written about it", async () => {
    const t = run();
    await server(t.gmail, "personal");
    await server(t.calendar, "personal", "API_KEY");
    await hold(t.gmail, t.person);
    await hold(t.calendar, t.person);

    await store.removeServer(t.gmail, "admin");

    expect(await rowsFor([t.gmail, t.calendar])).toEqual([t.calendar]);
    expect(
      (await trailFor([t.gmail, t.calendar])).map((event) => event.app),
    ).toEqual([t.gmail]);
  });

  test("a partial vendor failure throws and leaves every row standing", async () => {
    const t = run();
    await server(t.gmail, "personal");
    await hold(t.gmail, t.person);
    await hold(t.calendar, t.person);
    const failing = createPluginStore({
      brokerProvider: "arcade",
      database,
      auditStore: createAuditStore(database),
      credentials: {} as never,
      encryptionKey: "x".repeat(44),
      policy: () => ({ mode: "enforce" as const, deny: [], allow: ["true"] }),
      broker: {
        ...broker,
        revoke: async () => {
          throw new Error("vendor down");
        },
      },
      deploymentId: "acme",
      sharedUse: async () => ({ allowed: true }),
    });

    await expect(failing.removeServer(t.gmail, "admin")).rejects.toThrow(
      "vendor down",
    );

    expect(await rowsFor([t.gmail, t.calendar])).toEqual(
      [t.calendar, t.gmail].sort(),
    );
    expect(await trailFor([t.gmail, t.calendar])).toEqual([]);
  });
});

describe("offboarding a person", () => {
  /*
   * CRITERION. Every app the vendor ended as part of this offboarding is recorded as one the
   * vendor was asked about, and names the grant it went with.
   *
   * THE BROKER HERE IS ARCADE'S OWN SHAPE: one connection per (identity, auth provider). The
   * first revoke on a provider ends it and answers true; a second, for a sibling app on the same
   * connection, answers that there was nothing left to end. Passing that second answer through
   * untouched files the sibling as a grant nobody asked about, on the one trail that is supposed
   * to say whether the person's access was really withdrawn.
   */
  test("records a sibling app as revoked, naming the app whose revoke ended it", async () => {
    const t = run();
    await hold(t.gmail, t.person);
    await hold(t.calendar, t.person); // same identity, same provider: ended with Gmail
    await hold(t.slack, t.person); // its own provider: asked and answered on its own

    const ended = new Set<string>();
    const arcade: ConnectedAppBroker = {
      ...broker,
      revoke: async ({ account, toolkit }) => {
        const connection = `${account.vendorUserId}:${providerOf(toolkit)}`;
        if (ended.has(connection)) return false;
        ended.add(connection);
        return true;
      },
    };
    const arcadeStore = createPluginStore({
      brokerProvider: "arcade",
      database,
      auditStore: createAuditStore(database),
      credentials: {} as never,
      encryptionKey: "x".repeat(44),
      policy: () => ({ mode: "enforce" as const, deny: [], allow: ["true"] }),
      broker: arcade,
      deploymentId: "acme",
      sharedUse: async () => ({ allowed: true }),
    });

    expect(await arcadeStore.retireConnectionsFor(t.person, "admin")).toEqual({
      retired: 3,
    });
    expect(await rowsFor([t.gmail, t.calendar, t.slack])).toEqual([]);

    const trail = await trailFor([t.gmail, t.calendar, t.slack]);
    const row = (app: string) => trail.find((event) => event.app === app);
    // The app whose revoke ended the Google connection, and the one on its own provider: both
    // asked directly, neither ended with anything else.
    expect(row(t.gmail)?.payload).toMatchObject({
      reason: "person_removed",
      vendorRevocationRequested: true,
    });
    expect(row(t.gmail)?.payload.endedWith).toBeUndefined();
    expect(row(t.slack)?.payload).toMatchObject({
      vendorRevocationRequested: true,
    });
    expect(row(t.slack)?.payload.endedWith).toBeUndefined();
    // And the sibling, whose own ask answered false because Gmail's had already ended it.
    expect(row(t.calendar)?.payload).toMatchObject({
      reason: "person_removed",
      vendorRevocationRequested: true,
      endedWith: t.gmail,
      unansweredSiblings: 0,
    });
  });
});

/*
 * WHAT THE TRAIL SAYS ABOUT A KEY APP, on the two acts that used to decide it for themselves (round
 * 2, K5: A5b, A5c, L5-a). A key is a credential this deployment holds; no consent revoke at the
 * vendor reaches it, so no `mcp.account_disconnected` row may say a vendor was asked to withdraw
 * one — the reading `disconnectBrokered` already writes — nor that an OAuth sibling's revoke ended
 * it. The ROWS were already right on both acts; these hold what the trail says about why.
 */
describe("the trail about a KEY app", () => {
  /** A store over `revoke`, otherwise the file's own broker. */
  const storeWith = (revoke: ConnectedAppBroker["revoke"]) =>
    createPluginStore({
      brokerProvider: "arcade",
      database,
      auditStore: createAuditStore(database),
      credentials: {} as never,
      encryptionKey: "x".repeat(44),
      policy: () => ({ mode: "enforce" as const, deny: [], allow: ["true"] }),
      broker: { ...broker, revoke },
      deploymentId: "acme",
      sharedUse: async () => ({ allowed: true }),
    });
  /** The one trail row for `app`, or a failure naming what is missing. */
  async function onlyRowFor(app: string): Promise<Record<string, unknown>> {
    const rows = await trailFor([app]);
    if (rows.length !== 1 || !rows[0]) {
      throw new Error(
        `expected one trail row for ${app}, found ${rows.length}`,
      );
    }
    return rows[0].payload;
  }

  test("offboarding: an OAuth sibling's revoke is not named as what ended a KEY app", async () => {
    const t = run();
    await server(t.gmail, "personal");
    await server(t.calendar, "personal", "API_KEY");
    await hold(t.gmail, t.person);
    await hold(t.calendar, t.person);
    // Arcade's shape: Gmail is asked first, ends the Google connection and answers true; the KEY
    // app's own ask then finds nothing and answers false.
    const ended = new Set<string>();
    const arcadeStore = storeWith(async ({ account, toolkit }) => {
      const connection = `${account.vendorUserId}:${providerOf(toolkit)}`;
      if (ended.has(connection)) return false;
      ended.add(connection);
      return true;
    });

    await arcadeStore.retireConnectionsFor(t.person, "admin");

    expect(await onlyRowFor(t.calendar)).toEqual({
      actor: "admin",
      server: t.calendar,
      owner: t.person,
      reason: "person_removed",
      vendorRevocationRequested: false,
    });
  });

  test("offboarding: a KEY app's own revoke answering true is not filed as a vendor withdrawal", async () => {
    const t = run();
    await server(t.calendar, "personal", "API_KEY");
    await hold(t.calendar, t.person);

    await storeWith(async () => true).retireConnectionsFor(t.person, "admin");

    expect(await onlyRowFor(t.calendar)).toEqual({
      actor: "admin",
      server: t.calendar,
      owner: t.person,
      reason: "person_removed",
      vendorRevocationRequested: false,
    });
  });

  test("removing a KEY app: its own revoke answering true is not filed as a vendor withdrawal", async () => {
    const t = run();
    await server(t.calendar, "personal", "API_KEY");
    await hold(t.calendar, t.person);

    await storeWith(async () => true).removeServer(t.calendar, "admin");

    expect(await onlyRowFor(t.calendar)).toEqual({
      actor: "admin",
      server: t.calendar,
      owner: t.person,
      reason: "mcp_server_removed",
      vendorRevocationRequested: false,
    });
  });
});
