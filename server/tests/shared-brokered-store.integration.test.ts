// server/tests/shared-brokered-store.integration.test.ts
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { randomUUID } from "node:crypto";
import { readConnectPrompt } from "@openbot/shared/connect-prompt";
import { and, eq, inArray } from "drizzle-orm";
import { createAuditStore } from "../src/audit";
import { createDatabase } from "../src/db/client";
import {
  agents,
  auditEvents,
  brokeredConnections,
  mcpServers,
  mcpTools,
} from "../src/db/schema";
import {
  BrokerAccountGoneError,
  type ConnectedAppBroker,
} from "../src/plugins/broker";
import { useComposioClient } from "../src/plugins/composio";
import { createPluginStore } from "../src/plugins/store";
import { expectOnlyRefusal } from "./helpers/refusals";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const suite = randomUUID().slice(0, 8);
const app = `team-gh-${suite}`;
const bot = `bot-${suite}`;
const admin = `admin-${suite}`;
const asker = `asker-${suite}`;
const VENDOR_ID = `openbot-deployment:acme-${suite}:R`;
/*
 * A second row at the app's url. `zz-` sorts after `team-gh-` in any collation, so the seeded row
 * stays the one `brokeredAppRow` answers with — `order by id`, first row per url — and this is
 * always the duplicate.
 */
const duplicate = `zz-dup-${suite}`;

const revoked: string[] = [];
const broker: ConnectedAppBroker = {
  // This stub stands in for Composio, whose grant is held locally; see `ConnectedAppBroker.grantIsLocal`.
  grantIsLocal: true,
  // Nothing here asks what auth provider a connection is held under.
  authProviderOf: async () => null,
  // Nothing here reads either member; both are declared because the seam requires a broker to
  // SAY what it runs — see `ConnectedAppBroker.authorizations`.
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
  revoke: async ({ account }) => {
    revoked.push(account.vendorUserId);
    return true;
  },
  connectionFields: async () => [],
  connectWithFields: async () => ({ accountId: "ca_1" }),
  revokeAccount: async () => {},
  accountName: async () => "acme-bot",
};

const policy = { mode: "enforce" as const, deny: [], allow: ["true"] };
const credentialsStub = {} as never;

function freshStore() {
  return createPluginStore({
    brokerProvider: "composio",
    database,
    auditStore: createAuditStore(database),
    credentials: credentialsStub,
    encryptionKey: "x".repeat(44),
    policy: () => policy,
    broker,
    deploymentId: `acme-${suite}`,
    sharedUse: async () => ({ allowed: true }),
  });
}

async function seedShared(
  store: ReturnType<typeof freshStore>,
  connected: boolean,
) {
  await database.insert(mcpServers).values({
    id: app,
    title: "Team GitHub",
    vendor: "Composio",
    url: `composio://${app}`,
    provenance: "composio",
    authScheme: "OAUTH2",
    accountMode: "shared",
    sharedVendorUserId: VENDOR_ID,
  });
  await database.insert(mcpTools).values({
    serverId: app,
    name: "GITHUB_LIST_ISSUES",
    vendorName: "GITHUB_LIST_ISSUES",
    description: "List issues.",
    effect: "read",
    version: "1",
  });
  await database
    .insert(agents)
    .values({ id: bot, name: "Helper", type: "built_in", configuration: {} });
  await store.grant(
    "mcp",
    `${app}/GITHUB_LIST_ISSUES`,
    bot,
    "admin@example.test",
  );
  if (connected) {
    await database.insert(brokeredConnections).values({
      provider: "composio",
      app,
      holder: "deployment",
      vendorUserId: VENDOR_ID,
      connectedBy: admin,
      verified: true,
    });
  }
}

async function clean() {
  await database
    .delete(brokeredConnections)
    .where(eq(brokeredConnections.app, app));
  await database
    .delete(mcpServers)
    .where(inArray(mcpServers.id, [app, duplicate]));
  await database.delete(agents).where(eq(agents.id, bot));
}

beforeEach(async () => {
  revoked.length = 0;
  await clean();
});
afterEach(async () => {
  useComposioClient(null);
  await clean();
});

describe("a shared app", () => {
  test("is called under the deployment's stored vendor id, not the asker's", async () => {
    const store = freshStore();
    await seedShared(store, true);
    const sentAs: string[] = [];
    useComposioClient({
      listActions: async () => [],
      execute: async ({ userId }) => {
        sentAs.push(userId);
        return { successful: true, data: {}, error: null } as never;
      },
    });
    await store.callTool({
      ref: `${app}/GITHUB_LIST_ISSUES`,
      args: {},
      botId: bot,
      actorId: asker,
    });
    expect(sentAs).toEqual([VENDOR_ID]);
  });

  test("ignores a Team Bot's owner as the credential actor", async () => {
    const store = freshStore();
    await seedShared(store, true);
    const sentAs: string[] = [];
    useComposioClient({
      listActions: async () => [],
      execute: async ({ userId }) => {
        sentAs.push(userId);
        return { successful: true, data: {}, error: null } as never;
      },
    });
    await store.callTool({
      ref: `${app}/GITHUB_LIST_ISSUES`,
      args: {},
      botId: bot,
      actorId: asker,
      credentialActorId: "the-owner",
    });
    expect(sentAs).toEqual([VENDOR_ID]);
  });

  test("with no account connected refuses with the shared sentence and only that one", async () => {
    const store = freshStore();
    await seedShared(store, false);
    const said = await store
      .callTool({
        ref: `${app}/GITHUB_LIST_ISSUES`,
        args: {},
        botId: bot,
        actorId: asker,
      })
      .then(
        () => "called",
        (error: Error) => error.message,
      );
    expectOnlyRefusal(said, "sharedNotConnected", "Team GitHub");
    // And it carries the card, which asks an administrator rather than offering Connect.
    expect(readConnectPrompt(said)).toMatchObject({
      serverId: app,
      title: "Team GitHub",
      reason: "shared",
    });
  });

  test("offboarding the admin who connected it leaves it in place", async () => {
    const store = freshStore();
    await seedShared(store, true);
    await store.retireConnectionsFor(admin, "hr@example.test");
    const rows = await database
      .select()
      .from(brokeredConnections)
      .where(eq(brokeredConnections.app, app));
    expect(rows).toHaveLength(1);
    expect(revoked).toEqual([]);
  });

  test("reconnecting a shared account records the latest administrator", async () => {
    const store = freshStore();
    await store.recordBrokeredConnection({
      toolkit: app,
      account: { holder: "deployment", vendorUserId: VENDOR_ID },
      connectedBy: "admin-a",
      verified: true,
      probeAction: null,
    });
    await store.recordBrokeredConnection({
      toolkit: app,
      account: { holder: "deployment", vendorUserId: VENDOR_ID },
      connectedBy: "admin-b",
      verified: true,
      probeAction: null,
    });
    const rows = await database
      .select({ connectedBy: brokeredConnections.connectedBy })
      .from(brokeredConnections)
      .where(
        and(
          eq(brokeredConnections.app, app),
          eq(brokeredConnections.holder, "deployment"),
        ),
      );
    expect(rows).toEqual([{ connectedBy: "admin-b" }]);
  });

  /*
   * THE SUPERSEDE IS CONDITIONAL, AND THAT IS ITS OWN GUARD. A confirm or re-check that names no
   * administrator must not blank out the one an earlier connect recorded.
   */
  test("a write that names no administrator keeps the one already recorded", async () => {
    const store = freshStore();
    await store.recordBrokeredConnection({
      toolkit: app,
      account: { holder: "deployment", vendorUserId: VENDOR_ID },
      connectedBy: "admin-a",
      verified: true,
      probeAction: null,
    });
    await store.recordBrokeredConnection({
      toolkit: app,
      account: { holder: "deployment", vendorUserId: VENDOR_ID },
      verified: false,
      probeAction: null,
    });
    const rows = await database
      .select({ connectedBy: brokeredConnections.connectedBy })
      .from(brokeredConnections)
      .where(eq(brokeredConnections.app, app));
    expect(rows).toEqual([{ connectedBy: "admin-a" }]);
  });

  /*
   * THE ROW NAMES THE IDENTITY THE LATEST CONNECTION WAS MADE UNDER. Calls go out under the row's
   * `vendor_user_id`, so a reconnect under a new identity that rewrote the verdict and kept the old
   * id sent every later call to the account the verdict was not about.
   */
  test.each(["deployment", "person"] as const)(
    "a %s reconnect under a NEW vendor identity moves the row to it",
    async (holder) => {
      const store = freshStore();
      const as = (vendorUserId: string) =>
        holder === "deployment"
          ? { holder, vendorUserId }
          : { holder, userId: asker, vendorUserId };
      await store.recordBrokeredConnection({
        toolkit: app,
        account: as(`old-${suite}`),
        connectedBy: "admin-a",
        verified: true,
        probeAction: null,
      });
      await store.recordBrokeredConnection({
        toolkit: app,
        account: as(`new-${suite}`),
        connectedBy: "admin-b",
        verified: true,
        probeAction: null,
      });
      const rows = await database
        .select({ vendorUserId: brokeredConnections.vendorUserId })
        .from(brokeredConnections)
        .where(eq(brokeredConnections.app, app));
      expect(rows).toEqual([{ vendorUserId: `new-${suite}` }]);
    },
  );

  /*
   * AND A RE-CHECK NEVER RE-POINTS IT. The `only` branch records a check of a connection that
   * exists; it is not evidence of a grant under any identity, so it may not move the row's. Nor
   * may it stamp its verdict on the row: a probe of ANOTHER identity says nothing about the account
   * this row holds, so it finds no row of its own and writes nothing — `accountRow` matches the
   * deployment's identity as well as its holder.
   */
  test("a re-check write under another identity leaves the row alone", async () => {
    const store = freshStore();
    await store.recordBrokeredConnection({
      toolkit: app,
      account: { holder: "deployment", vendorUserId: VENDOR_ID },
      connectedBy: "admin-a",
      verified: true,
      probeAction: null,
    });
    const { wrote } = await store.recordBrokeredConnection({
      toolkit: app,
      account: { holder: "deployment", vendorUserId: `other-${suite}` },
      verified: false,
      probeAction: "GITHUB_LIST_ISSUES",
      only: "a row that is still there",
    });
    expect(wrote).toBe(false);
    const rows = await database
      .select({
        vendorUserId: brokeredConnections.vendorUserId,
        verified: brokeredConnections.verified,
      })
      .from(brokeredConnections)
      .where(eq(brokeredConnections.app, app));
    expect(rows).toEqual([{ vendorUserId: VENDOR_ID, verified: true }]);
  });

  test("removing the app revokes the deployment account too", async () => {
    const store = freshStore();
    await seedShared(store, true);
    await store.removeServer(app, "admin@example.test");
    expect(revoked).toContain(VENDOR_ID);
  });

  test("audits the call as reached by the deployment, naming who asked", async () => {
    const events: { eventType: string; payload: Record<string, unknown> }[] =
      [];
    const store = createPluginStore({
      brokerProvider: "composio",
      database,
      auditStore: { insert: async (event) => void events.push(event as never) },
      credentials: credentialsStub,
      encryptionKey: "x".repeat(44),
      policy: () => policy,
      broker,
      deploymentId: `acme-${suite}`,
      sharedUse: async () => ({ allowed: true }),
    });
    await seedShared(store, true);
    useComposioClient({
      listActions: async () => [],
      execute: async () =>
        ({ successful: true, data: {}, error: null }) as never,
    });
    await store.callTool({
      ref: `${app}/GITHUB_LIST_ISSUES`,
      args: {},
      botId: bot,
      actorId: asker,
    });
    const success = events.find(
      (event) => event.eventType === "mcp.call_succeeded",
    );
    expect(success?.payload).toMatchObject({
      actor: asker,
      reachedAs: "deployment",
    });
  });

  test("with no audience gate configured, a shared call is refused rather than allowed", async () => {
    const store = createPluginStore({
      brokerProvider: "composio",
      database,
      auditStore: createAuditStore(database),
      credentials: credentialsStub,
      encryptionKey: "x".repeat(44),
      policy: () => policy,
      broker,
      deploymentId: `acme-${suite}`,
    });
    await seedShared(store, true);
    await expect(
      store.callTool({
        ref: `${app}/GITHUB_LIST_ISSUES`,
        args: {},
        botId: bot,
        actorId: asker,
      }),
    ).rejects.toThrow(/can't check who may use it/);
  });
});

describe("a personal app", () => {
  test("still refuses a person with no account with the personal sentence", async () => {
    const store = freshStore();
    await seedShared(store, false);
    await database
      .update(mcpServers)
      .set({ accountMode: "personal", sharedVendorUserId: null })
      .where(eq(mcpServers.id, app));
    const said = await store
      .callTool({
        ref: `${app}/GITHUB_LIST_ISSUES`,
        args: {},
        botId: bot,
        actorId: asker,
      })
      .then(
        () => "called",
        (error: Error) => error.message,
      );
    expectOnlyRefusal(said, "personalNotConnected", "Team GitHub");
  });

  test("offboarding a person revokes only their own rows", async () => {
    const store = freshStore();
    await seedShared(store, true);
    await database
      .update(mcpServers)
      .set({ accountMode: "personal" })
      .where(eq(mcpServers.id, app));
    await database.insert(brokeredConnections).values({
      provider: "composio",
      app,
      holder: "person",
      userId: asker,
      vendorUserId: asker,
    });
    await store.retireConnectionsFor(asker, "hr@example.test");
    const left = await database
      .select({ holder: brokeredConnections.holder })
      .from(brokeredConnections)
      .where(
        and(
          eq(brokeredConnections.app, app),
          inArray(brokeredConnections.holder, ["person", "deployment"]),
        ),
      );
    expect(left).toEqual([{ holder: "deployment" }]);
    expect(revoked).toEqual([asker]);
  });
});

describe("a duplicate row at an app's url", () => {
  async function seedDuplicate(
    store: ReturnType<typeof createPluginStore>,
    columns: {
      accountMode: "personal" | "shared";
      sharedVendorUserId: string | null;
    },
  ) {
    await database.insert(mcpServers).values({
      id: duplicate,
      title: "Team GitHub (copy)",
      vendor: "Composio",
      url: `composio://${app}`,
      provenance: "composio",
      authScheme: "OAUTH2",
      ...columns,
    });
    await database.insert(mcpTools).values({
      serverId: duplicate,
      name: "GITHUB_LIST_ISSUES",
      vendorName: "GITHUB_LIST_ISSUES",
      description: "List issues.",
      effect: "read",
      version: "1",
    });
    await store.grant(
      "mcp",
      `${duplicate}/GITHUB_LIST_ISSUES`,
      bot,
      "admin@example.test",
    );
  }

  test("saying personal does not take a call to a Shared app round the audience gate", async () => {
    const gateSaw: { serverId: string }[] = [];
    const events: { eventType: string; payload: Record<string, unknown> }[] =
      [];
    const store = createPluginStore({
      brokerProvider: "composio",
      database,
      auditStore: { insert: async (event) => void events.push(event as never) },
      credentials: credentialsStub,
      encryptionKey: "x".repeat(44),
      policy: () => policy,
      broker,
      deploymentId: `acme-${suite}`,
      sharedUse: async (input) => {
        gateSaw.push({ serverId: input.serverId });
        return { allowed: false, message: "Not for this audience." };
      },
    });
    await seedShared(store, true);
    await seedDuplicate(store, {
      accountMode: "personal",
      sharedVendorUserId: null,
    });
    const sentAs: string[] = [];
    useComposioClient({
      listActions: async () => [],
      execute: async ({ userId }) => {
        sentAs.push(userId);
        return { successful: true, data: {}, error: null } as never;
      },
    });
    await expect(
      store.callTool({
        ref: `${duplicate}/GITHUB_LIST_ISSUES`,
        args: {},
        botId: bot,
        actorId: asker,
      }),
    ).rejects.toThrow("Not for this audience.");
    expect(gateSaw).toEqual([{ serverId: app }]);
    expect(sentAs).toEqual([]);
    expect(
      events.find((event) => event.eventType === "mcp.call_rejected")?.payload,
    ).toMatchObject({ refusal: "shared_audience", reachedAs: "deployment" });
  });

  test("saying shared does not send a Personal app's call out as the deployment", async () => {
    const gateSaw: string[] = [];
    const events: { eventType: string; payload: Record<string, unknown> }[] =
      [];
    const store = createPluginStore({
      brokerProvider: "composio",
      database,
      auditStore: { insert: async (event) => void events.push(event as never) },
      credentials: credentialsStub,
      encryptionKey: "x".repeat(44),
      policy: () => policy,
      broker,
      deploymentId: `acme-${suite}`,
      sharedUse: async (input) => {
        gateSaw.push(input.serverId);
        return { allowed: true };
      },
    });
    // The deployment account exists, so taking the Shared branch would succeed rather than refuse.
    await seedShared(store, true);
    await database
      .update(mcpServers)
      .set({ accountMode: "personal", sharedVendorUserId: null })
      .where(eq(mcpServers.id, app));
    await database.insert(brokeredConnections).values({
      provider: "composio",
      app,
      holder: "person",
      userId: asker,
      vendorUserId: asker,
      verified: true,
    });
    await seedDuplicate(store, {
      accountMode: "shared",
      sharedVendorUserId: VENDOR_ID,
    });
    const sentAs: string[] = [];
    useComposioClient({
      listActions: async () => [],
      execute: async ({ userId }) => {
        sentAs.push(userId);
        return { successful: true, data: {}, error: null } as never;
      },
    });
    await store.callTool({
      ref: `${duplicate}/GITHUB_LIST_ISSUES`,
      args: {},
      botId: bot,
      actorId: asker,
    });
    expect(sentAs).toEqual([asker]);
    expect(gateSaw).toEqual([]);
    expect(
      events.find((event) => event.eventType === "mcp.call_succeeded")?.payload,
    ).toMatchObject({ reachedAs: asker });
  });

  test("asks the approval gate under the app's id for a write granted through it", async () => {
    const gateSaw: { toolRef: string; scope: string }[] = [];
    const store = createPluginStore({
      brokerProvider: "composio",
      database,
      auditStore: createAuditStore(database),
      credentials: credentialsStub,
      encryptionKey: "x".repeat(44),
      policy: () => policy,
      broker,
      deploymentId: `acme-${suite}`,
      sharedUse: async () => ({ allowed: true }),
      approvalGate: async (candidate) => {
        gateSaw.push({ toolRef: candidate.toolRef, scope: candidate.scope });
        return undefined;
      },
    });
    await seedShared(store, true);
    await seedDuplicate(store, {
      accountMode: "shared",
      sharedVendorUserId: VENDOR_ID,
    });
    await database.insert(mcpTools).values({
      serverId: duplicate,
      name: "GITHUB_CREATE_ISSUE",
      vendorName: "GITHUB_CREATE_ISSUE",
      description: "Create an issue.",
      effect: "write",
      version: "1",
    });
    await store.grant(
      "mcp",
      `${duplicate}/GITHUB_CREATE_ISSUE`,
      bot,
      "admin@example.test",
    );
    useComposioClient({
      listActions: async () => [],
      execute: async () =>
        ({ successful: true, data: {}, error: null }) as never,
    });
    await store.callTool({
      ref: `${duplicate}/GITHUB_CREATE_ISSUE`,
      args: {},
      botId: bot,
      actorId: asker,
    });
    expect(gateSaw).toEqual([
      { toolRef: `${app}/GITHUB_CREATE_ISSUE`, scope: app },
    ]);
  });

  test("a mode written through the duplicate lands on the row that answers", async () => {
    const store = freshStore();
    await seedShared(store, false);
    await seedDuplicate(store, {
      accountMode: "shared",
      sharedVendorUserId: VENDOR_ID,
    });
    await store.setAccountModeColumns(duplicate, "personal", null);
    const rows = await database
      .select({ id: mcpServers.id, accountMode: mcpServers.accountMode })
      .from(mcpServers)
      .where(inArray(mcpServers.id, [app, duplicate]))
      .orderBy(mcpServers.id);
    expect(rows).toEqual([
      { id: app, accountMode: "personal" },
      { id: duplicate, accountMode: "shared" },
    ]);
  });
});

/*
 * THE ACCOUNT GONE AT THE VENDOR. Nothing on this deployment's rows knows it happened, so the call
 * that meets it is the only place the person can be told: refused with the app card, `reconnect`
 * for their own account and `shared` for the team's, stamped with when — and audited once, as the
 * failure it is.
 */
describe("an account the vendor no longer holds", () => {
  const gone = () =>
    useComposioClient({
      listActions: async () => [],
      execute: async () => {
        throw new BrokerAccountGoneError(
          "Composio holds no connected account for this person and team-gh, so GITHUB_LIST_ISSUES was not run.",
        );
      },
    });

  /** Who still holds a row at the app, by holder. */
  const rowsFor = async (holder: "person" | "deployment") =>
    (
      await database
        .select({ userId: brokeredConnections.userId })
        .from(brokeredConnections)
        .where(
          and(
            eq(brokeredConnections.app, app),
            eq(brokeredConnections.holder, holder),
          ),
        )
    ).map((row) => row.userId);

  /* Counted before and after: the trail is not cleaned between tests, which share the app id. */
  const failures = async () =>
    (
      await database
        .select({ eventType: auditEvents.eventType })
        .from(auditEvents)
        .where(eq(auditEvents.targetId, `${app}/GITHUB_LIST_ISSUES`))
    ).filter((row) => row.eventType === "mcp.call_failed").length;

  test("on a Shared app: refused with a card saying an administrator has to connect it again", async () => {
    const store = freshStore();
    await seedShared(store, true);
    gone();
    const already = await failures();
    const before = Date.now();
    const said = await store
      .callTool({
        ref: `${app}/GITHUB_LIST_ISSUES`,
        args: {},
        botId: bot,
        actorId: asker,
      })
      .then(
        () => "called",
        (error: Error) => error.message,
      );
    const prompt = readConnectPrompt(said);
    expect(prompt).toMatchObject({
      serverId: app,
      title: "Team GitHub",
      reason: "shared",
    });
    expect(prompt?.message).toContain("Ask an admin to reconnect it");
    expect(Date.parse(prompt?.at ?? "")).toBeGreaterThanOrEqual(before - 1000);
    expect(await failures()).toBe(already + 1);
    // The team account's row is gone with the account, so every screen reads it as not connected.
    expect(await rowsFor("deployment")).toEqual([]);
  });

  test("on a personal app: refused with a card offering Reconnect", async () => {
    const store = freshStore();
    await seedShared(store, false);
    await database
      .update(mcpServers)
      .set({ accountMode: "personal", sharedVendorUserId: null })
      .where(eq(mcpServers.id, app));
    await database.insert(brokeredConnections).values([
      {
        provider: "composio",
        app,
        holder: "person",
        userId: asker,
        vendorUserId: `vendor-${asker}`,
      },
      // Somebody else's account at the same app, which the vendor still holds.
      {
        provider: "composio",
        app,
        holder: "person",
        userId: admin,
        vendorUserId: `vendor-${admin}`,
      },
    ]);
    gone();
    const said = await store
      .callTool({
        ref: `${app}/GITHUB_LIST_ISSUES`,
        args: {},
        botId: bot,
        actorId: asker,
      })
      .then(
        () => "called",
        (error: Error) => error.message,
      );
    expect(readConnectPrompt(said)).toMatchObject({
      serverId: app,
      reason: "reconnect",
    });
    expect(said).toContain("Reconnect it and ask again");
    // Only the asker's row goes, so Connect on their card starts a fresh connection.
    expect(await rowsFor("person")).toEqual([admin]);
  });
});

afterAll(async () => {
  await database.$client.close();
});
