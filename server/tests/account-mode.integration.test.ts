// server/tests/account-mode.integration.test.ts
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { randomUUID } from "node:crypto";
import { createAuditStore } from "../src/audit";
import { createCredentialStore } from "../src/credentials";
import { createDatabase } from "../src/db/client";
import { createAccountModeSwitch } from "../src/plugins/account-mode";
import type { ConnectedAppBroker } from "../src/plugins/broker";
import { createSharedUseStore } from "../src/plugins/shared-use-store";
import { createPluginStore } from "../src/plugins/store";
import {
  grantBot,
  removeBots,
  seedBot,
  useTestConfiguration,
} from "./support/bots";
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
import { storedConnectionApprovals, useTestPolicy } from "./support/policy";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);

beforeAll(async () => {
  await useTestConfiguration();
});
const suite = randomUUID().slice(0, 8);
const app = `mode-${suite}`;
const bot = `modebot-${suite}`;
let failRevokeFor: string | null = null;
let failCreateRule = false;
const revoked: string[] = [];
const rules: {
  id: string;
  toolRef: string;
  behaviour: string;
  revokedAt: Date | null;
}[] = [];

const broker = {
  // This stub stands in for Composio, whose grant is held locally and which runs no
  // correlated authorization flow; see `ConnectedAppBroker.grantIsLocal` and `.authorizations`.
  grantIsLocal: true,
  // Nothing here asks what auth provider a connection is held under.
  authProviderOf: async () => null,
  authorizations: null,
  grantsFor: async () => [],
  listApps: async () => [],
  ensureAuthConfig: async () => "standing",
  deleteAuthConfig: async () => {},
  authorize: async () => ({ redirectUrl: "x", authorizationId: null }),
  isConnected: async () => true,
  revoke: async ({ account }) => {
    if (account.vendorUserId === failRevokeFor)
      throw new Error("Composio said no.");
    revoked.push(account.vendorUserId);
    return true;
  },
  connectionFields: async () => [],
  connectWithFields: async () => ({ accountId: "a" }),
  revokeAccount: async () => {},
  accountName: async () => null,
} satisfies ConnectedAppBroker;

let store: ReturnType<typeof createPluginStore>;
const sharedUse = createSharedUseStore(database, "composio");
let modes: ReturnType<typeof createAccountModeSwitch>;

beforeAll(async () => {
  store = createPluginStore({
    brokerProvider: "composio",
    database,
    auditStore: createAuditStore(database),
    credentials: createCredentialStore(await useTestVault()),
    encryptionKey: "x".repeat(44),
    policy: () => ({ mode: "enforce", deny: [], allow: ["true"] }),
    broker,
    deploymentId: "acme",
    sharedUse: async () => ({ allowed: true }),
  });
  modes = createAccountModeSwitch({
    store,
    sharedUse,
    deploymentId: "acme",
    audit: createAuditStore(database),
    teamRules: {
      createTeamRule: async (_by, input) => {
        if (failCreateRule)
          throw new Error("The approval store is unavailable.");
        const rule = {
          id: randomUUID(),
          ...input,
          revokedAt: null,
          createdAt: new Date(),
          createdBy: null,
        };
        rules.push(rule as never);
        return rule as never;
      },
      teamRules: async () => rules as never,
      revokeTeamRule: async (_by, id) => {
        const rule = rules.find((row) => row.id === id);
        if (rule) rule.revokedAt = new Date();
      },
    },
  });
});

/** The app as Intelligence holds it now. */
const appNow = () => storedServer(app);

beforeEach(async () => {
  await useTestPolicy();
  failRevokeFor = null;
  failCreateRule = false;
  revoked.length = 0;
  rules.length = 0;
  await seedServer({
    id: app,
    title: "Linear",
    vendor: "Composio",
    url: `composio://${app}`,
    provenance: "composio",
    authScheme: "OAUTH2",
    accountMode: "personal",
  });
  // Public and ownerless, as a package's Bot is: the whole team is who it answers, so "team" is the
  // audience a switch to Shared proposes for it.
  await seedBot({
    id: bot,
    name: "Ops",
    type: "built_in",
    visibility: "public",
  });
  await grantBot(bot, "mcp", `${app}/LINEAR_LIST`, {
    grantedBy: "admin@example.test",
  });
  for (const person of [`p1-${suite}`, `p2-${suite}`])
    await seedBrokered({
      provider: "composio",
      app,
      holder: "person",
      userId: person,
      vendorUserId: person,
    });
});
afterEach(async () => {
  await removeConnectionsWhere(
    (connection) => connection.kind === "brokered" && connection.app === app,
  );
  await removeBots([bot]);
  // Takes the app's grants and approvals here with it, as the cascade from mcp_servers did.
  await removeServers([app]);
});

describe("switching to Shared", () => {
  test("without confirm, names what would go and changes nothing", async () => {
    const result = await modes.switchMode({
      serverId: app,
      mode: "shared",
      by: "admin",
      confirm: false,
    });
    expect(result).toEqual({
      changed: false,
      preview: {
        mode: "shared",
        wouldRevoke: { holder: "person", count: 2 },
        bots: [
          {
            botId: bot,
            exposure: { audience: "team", outsideInput: false, members: [] },
          },
        ],
      },
    });
    expect(revoked).toEqual([]);
    const row = await appNow();
    expect(row?.accountMode).toBe("personal");
  });

  test("with confirm, revokes people's accounts, mints an identity, approves each Bot and adds the ask rule", async () => {
    const result = await modes.switchMode({
      serverId: app,
      mode: "shared",
      by: "admin",
      confirm: true,
    });
    expect(result).toEqual({ changed: true, revoked: 2 });
    expect(revoked.sort()).toEqual([`p1-${suite}`, `p2-${suite}`]);
    const row = await appNow();
    expect(row?.accountMode).toBe("shared");
    expect(row?.sharedVendorUserId).toMatch(/^openbot-deployment:acme:.+/);
    expect(await storedConnectionApprovals({ connectionId: app })).toHaveLength(
      1,
    );
    expect(rules).toEqual([
      expect.objectContaining({
        toolRef: `${app}/*`,
        behaviour: "ask",
        effect: "write",
        scope: app,
        botId: "*",
      }),
    ]);
  });

  test("an admin's narrower approval for a Bot is the one written", async () => {
    await modes.switchMode({
      serverId: app,
      mode: "shared",
      by: "admin",
      confirm: true,
      approvals: {
        [bot]: { audience: "owner", outsideInput: false, members: [] },
      },
    });
    expect(await sharedUse.approvalFor(bot, app)).toEqual({
      audience: "owner",
      outsideInput: false,
      members: [],
    });
  });

  test("if one revoke fails, the mode stays, only the revoked row goes, and the vendor's sentence is reported", async () => {
    failRevokeFor = `p2-${suite}`;
    const result = await modes.switchMode({
      serverId: app,
      mode: "shared",
      by: "admin",
      confirm: true,
    });
    expect(result).toEqual({
      changed: false,
      failures: [{ account: `p2-${suite}`, error: "Composio said no." }],
    });
    const left = (await storedConnections()).brokered
      .filter((connection) => connection.app === app)
      .map((connection) => ({ userId: connection.userId }));
    expect(left).toEqual([{ userId: `p2-${suite}` }]);
    const row = await appNow();
    expect(row?.accountMode).toBe("personal");
  });
});

describe("a switch that fails between its steps", () => {
  const modeNow = async () => (await appNow())?.accountMode;
  const standingRules = () =>
    rules.filter(
      (rule) =>
        rule.revokedAt === null &&
        rule.toolRef === `${app}/*` &&
        rule.behaviour === "ask",
    );

  test("a write rule that cannot be made leaves the app Personal, and a retry finishes the switch", async () => {
    failCreateRule = true;
    await expect(
      modes.switchMode({
        serverId: app,
        mode: "shared",
        by: "admin",
        confirm: true,
      }),
    ).rejects.toThrow("The approval store is unavailable.");
    // Never Shared without its ask-before-write rule, not even between the steps.
    expect(await modeNow()).toBe("personal");

    failCreateRule = false;
    expect(
      (
        await modes.switchMode({
          serverId: app,
          mode: "shared",
          by: "admin",
          confirm: true,
        })
      ).changed,
    ).toBe(true);
    expect(await modeNow()).toBe("shared");
    expect(standingRules()).toHaveLength(1);
    expect(await sharedUse.approvalFor(bot, app)).not.toBeNull();
  });

  test("an app already Shared with no write rule gets it back, and keeps the approval an admin set", async () => {
    await modes.switchMode({
      serverId: app,
      mode: "shared",
      by: "admin",
      confirm: true,
      approvals: {
        [bot]: { audience: "owner", outsideInput: false, members: [] },
      },
    });
    // As a switch from before the steps were ordered could have left it.
    rules.length = 0;
    expect(
      await modes.switchMode({
        serverId: app,
        mode: "shared",
        by: "admin",
        confirm: true,
      }),
    ).toEqual({ changed: true, revoked: 0 });
    expect(standingRules()).toHaveLength(1);
    expect(await sharedUse.approvalFor(bot, app)).toEqual({
      audience: "owner",
      outsideInput: false,
      members: [],
    });
    // Asked again, nothing is duplicated.
    await modes.switchMode({
      serverId: app,
      mode: "shared",
      by: "admin",
      confirm: true,
    });
    expect(standingRules()).toHaveLength(1);
  });

  test("a Personal app left holding the switch's rule loses it on the next switch to Personal", async () => {
    await modes.switchMode({
      serverId: app,
      mode: "shared",
      by: "admin",
      confirm: true,
    });
    // As a switch back that stopped after the mode could have left it.
    await store.setAccountModeColumns(app, "personal", null);
    expect(standingRules()).toHaveLength(1);
    await modes.switchMode({
      serverId: app,
      mode: "personal",
      by: "admin",
      confirm: true,
    });
    expect(standingRules()).toHaveLength(0);
    expect(await sharedUse.approvalFor(bot, app)).toBeNull();
  });
});

describe("switching back to Personal", () => {
  test("revokes the shared account, clears its identity and approvals, and revokes the rule", async () => {
    await modes.switchMode({
      serverId: app,
      mode: "shared",
      by: "admin",
      confirm: true,
    });
    const row = await appNow();
    await seedBrokered({
      provider: "composio",
      app,
      holder: "deployment",
      vendorUserId: row!.sharedVendorUserId!,
    });
    revoked.length = 0;
    expect(
      await modes.switchMode({
        serverId: app,
        mode: "personal",
        by: "admin",
        confirm: true,
      }),
    ).toEqual({ changed: true, revoked: 1 });
    expect(revoked).toEqual([row!.sharedVendorUserId]);
    const after = await appNow();
    expect(after).toMatchObject({
      accountMode: "personal",
      sharedVendorUserId: null,
    });
    expect(await sharedUse.approvalFor(bot, app)).toBeNull();
    expect(rules[0]?.revokedAt).not.toBeNull();
  });

  test("setting the mode it already has does nothing", async () => {
    expect(
      await modes.switchMode({
        serverId: app,
        mode: "personal",
        by: "admin",
        confirm: true,
      }),
    ).toEqual({ changed: true, revoked: 0 });
    expect(revoked).toEqual([]);
  });

  test("forgetting a removed app's rule revokes the ask-before-write rule it added", async () => {
    await modes.switchMode({
      serverId: app,
      mode: "shared",
      by: "admin",
      confirm: true,
    });
    await modes.forgetRule(app, "admin");
    expect(rules[0]?.revokedAt).not.toBeNull();
  });
});

afterAll(async () => {
  await database.$client.close();
});
