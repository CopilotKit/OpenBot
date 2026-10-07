// server/tests/account-mode.integration.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { createAuditStore } from "../src/audit";
import { createDatabase } from "../src/db/client";
import { agents, brokeredConnections, mcpServers, pluginGrants, sharedUseApprovals } from "../src/db/schema";
import { createAccountModeSwitch } from "../src/plugins/account-mode";
import type { ConnectedAppBroker } from "../src/plugins/broker";
import { createSharedUseStore } from "../src/plugins/shared-use-store";
import { createPluginStore } from "../src/plugins/store";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const suite = randomUUID().slice(0, 8);
const app = `mode-${suite}`;
const bot = `modebot-${suite}`;
let failRevokeFor: string | null = null;
const revoked: string[] = [];
const rules: { id: string; toolRef: string; behaviour: string; revokedAt: Date | null }[] = [];

const broker = {
  listApps: async () => [], ensureAuthConfig: async () => "standing", deleteAuthConfig: async () => {},
  authorize: async () => ({ redirectUrl: "x" }), isConnected: async () => true,
  revoke: async ({ account }) => {
    if (account.vendorUserId === failRevokeFor) throw new Error("Composio said no.");
    revoked.push(account.vendorUserId);
    return true;
  },
  connectionFields: async () => [], connectWithFields: async () => ({ accountId: "a" }),
  revokeAccount: async () => {}, accountName: async () => null,
} satisfies ConnectedAppBroker;

const store = createPluginStore({
  database, auditStore: createAuditStore(database), credentials: {} as never, encryptionKey: "x".repeat(44),
  policy: () => ({ mode: "enforce", deny: [], allow: ["true"] }), broker, deploymentId: "acme",
  sharedUse: async () => ({ allowed: true }),
});
const sharedUse = createSharedUseStore(database);
const modes = createAccountModeSwitch({
  store, sharedUse, deploymentId: "acme", audit: createAuditStore(database),
  teamRules: {
    createTeamRule: async (_by, input) => {
      const rule = { id: randomUUID(), ...input, revokedAt: null, createdAt: new Date(), createdBy: null };
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

beforeEach(async () => {
  failRevokeFor = null;
  revoked.length = 0;
  rules.length = 0;
  await database.insert(mcpServers).values({
    id: app, title: "Linear", vendor: "Composio", url: `composio://${app}`, provenance: "composio", authScheme: "OAUTH2", accountMode: "personal",
  });
  await database.insert(agents).values({ id: bot, name: "Ops", type: "built_in", configuration: {} });
  await database.insert(pluginGrants).values({ kind: "mcp", ref: `${app}/LINEAR_LIST`, agentId: bot, grantedBy: "admin@example.test" });
  await database.insert(brokeredConnections).values([
    { provider: "composio", app, holder: "person", userId: `p1-${suite}`, vendorUserId: `p1-${suite}` },
    { provider: "composio", app, holder: "person", userId: `p2-${suite}`, vendorUserId: `p2-${suite}` },
  ]);
});
afterEach(async () => {
  await database.delete(brokeredConnections).where(eq(brokeredConnections.app, app));
  await database.delete(agents).where(eq(agents.id, bot));
  await database.delete(mcpServers).where(eq(mcpServers.id, app));
});

describe("switching to Shared", () => {
  test("without confirm, names what would go and changes nothing", async () => {
    const result = await modes.switchMode({ serverId: app, mode: "shared", by: "admin", confirm: false });
    expect(result).toEqual({
      changed: false,
      preview: {
        mode: "shared", wouldRevoke: { holder: "person", count: 2 },
        bots: [{ botId: bot, exposure: { audience: "team", outsideInput: false, members: [] } }],
      },
    });
    expect(revoked).toEqual([]);
    const [row] = await database.select().from(mcpServers).where(eq(mcpServers.id, app));
    expect(row?.accountMode).toBe("personal");
  });

  test("with confirm, revokes people's accounts, mints an identity, approves each Bot and adds the ask rule", async () => {
    const result = await modes.switchMode({ serverId: app, mode: "shared", by: "admin", confirm: true });
    expect(result).toEqual({ changed: true, revoked: 2 });
    expect(revoked.sort()).toEqual([`p1-${suite}`, `p2-${suite}`]);
    const [row] = await database.select().from(mcpServers).where(eq(mcpServers.id, app));
    expect(row?.accountMode).toBe("shared");
    expect(row?.sharedVendorUserId).toMatch(/^openbot-deployment:acme:.+/);
    expect(await database.select().from(sharedUseApprovals).where(eq(sharedUseApprovals.serverId, app))).toHaveLength(1);
    expect(rules).toEqual([expect.objectContaining({ toolRef: `${app}/*`, behaviour: "ask", effect: "write", scope: app, botId: "*" })]);
  });

  test("an admin's narrower approval for a Bot is the one written", async () => {
    await modes.switchMode({
      serverId: app, mode: "shared", by: "admin", confirm: true,
      approvals: { [bot]: { audience: "owner", outsideInput: false, members: [] } },
    });
    expect(await sharedUse.approvalFor(bot, app)).toEqual({ audience: "owner", outsideInput: false, members: [] });
  });

  test("if one revoke fails, the mode stays, only the revoked row goes, and the vendor's sentence is reported", async () => {
    failRevokeFor = `p2-${suite}`;
    const result = await modes.switchMode({ serverId: app, mode: "shared", by: "admin", confirm: true });
    expect(result).toEqual({ changed: false, failures: [{ account: `p2-${suite}`, error: "Composio said no." }] });
    const left = await database.select({ userId: brokeredConnections.userId }).from(brokeredConnections).where(eq(brokeredConnections.app, app));
    expect(left).toEqual([{ userId: `p2-${suite}` }]);
    const [row] = await database.select().from(mcpServers).where(eq(mcpServers.id, app));
    expect(row?.accountMode).toBe("personal");
  });
});

describe("switching back to Personal", () => {
  test("revokes the shared account, clears its identity and approvals, and revokes the rule", async () => {
    await modes.switchMode({ serverId: app, mode: "shared", by: "admin", confirm: true });
    const [row] = await database.select().from(mcpServers).where(eq(mcpServers.id, app));
    await database.insert(brokeredConnections).values({ provider: "composio", app, holder: "deployment", vendorUserId: row!.sharedVendorUserId! });
    revoked.length = 0;
    expect(await modes.switchMode({ serverId: app, mode: "personal", by: "admin", confirm: true })).toEqual({ changed: true, revoked: 1 });
    expect(revoked).toEqual([row!.sharedVendorUserId]);
    const [after] = await database.select().from(mcpServers).where(eq(mcpServers.id, app));
    expect(after).toMatchObject({ accountMode: "personal", sharedVendorUserId: null });
    expect(await sharedUse.approvalFor(bot, app)).toBeNull();
    expect(rules[0]?.revokedAt).not.toBeNull();
  });

  test("setting the mode it already has does nothing", async () => {
    expect(await modes.switchMode({ serverId: app, mode: "personal", by: "admin", confirm: true })).toEqual({ changed: true, revoked: 0 });
    expect(revoked).toEqual([]);
  });

  test("forgetting a removed app's rule revokes the ask-before-write rule it added", async () => {
    await modes.switchMode({ serverId: app, mode: "shared", by: "admin", confirm: true });
    await modes.forgetRule(app, "admin");
    expect(rules[0]?.revokedAt).not.toBeNull();
  });
});
