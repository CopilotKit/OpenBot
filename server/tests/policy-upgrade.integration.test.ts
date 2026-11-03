import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, inArray, like } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import {
  actionPolicy,
  approvalPreferences,
  approvalRules,
  approvalTeamRules,
  approvalTeamSettings,
  capabilitySettings,
  enterpriseSettings,
  intelligenceCopies,
  mcpServers,
  networkPolicies,
  sharedUseApprovalMembers,
  sharedUseApprovals,
  users,
} from "../src/db/schema";
import type { PolicyCache } from "../src/policy/cache";
import {
  POLICY_COPY_NAME,
  PolicyCopyMismatchError,
  copyLocalPolicyToIntelligence,
} from "../src/policy/upgrade";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import { resetTestPolicy, useTestPolicy } from "./support/policy";

/**
 * An existing deployment's policy, moved into Intelligence once, at boot.
 *
 * The local tables are seeded the way the previous release wrote them, and the copy is run the way
 * index.ts runs it: against the real Intelligence, through the real client. Every record must be in
 * Intelligence afterwards with the values, authors and timestamps it had, the copy must record itself
 * so it never runs again, and it must never write over what Intelligence already holds.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const suite = randomUUID().slice(0, 8);
const id = (name: string) => `${name}-${suite}`;
const person = id("person");
const admin = id("admin");
const app = id("app");
const bot = id("bot");
const created = new Date("2026-09-01T12:00:00.000Z");

let cache: PolicyCache;

async function clearLocal() {
  await database
    .delete(intelligenceCopies)
    .where(eq(intelligenceCopies.name, POLICY_COPY_NAME));
  await database.delete(enterpriseSettings);
  await database.delete(approvalTeamSettings);
  await database.delete(actionPolicy);
  await database.delete(capabilitySettings);
  await database.delete(networkPolicies);
  await database
    .delete(approvalPreferences)
    .where(like(approvalPreferences.ownerUserId, `%${suite}`));
  await database
    .delete(approvalRules)
    .where(like(approvalRules.id, `%${suite}`));
  await database
    .delete(approvalTeamRules)
    .where(like(approvalTeamRules.id, `%${suite}`));
  await database
    .delete(sharedUseApprovals)
    .where(eq(sharedUseApprovals.serverId, app));
}

/** Every policy table as the previous release left it. */
async function seedPreviousRelease() {
  await database.insert(enterpriseSettings).values([
    { key: "sso_required", value: { value: true }, updatedBy: admin },
    { key: "inactive_computer_days", value: { value: 7 }, updatedBy: admin },
    {
      key: "model_allowlist",
      value: { value: { enabled: true, models: ["openai/gpt-test"] } },
      updatedBy: admin,
    },
    { key: "proactive_daily_runs", value: { value: 3 }, updatedBy: admin },
  ]);
  await database.insert(approvalTeamSettings).values({
    id: "team",
    enforceAutoReview: true,
    customRulesEnabled: false,
    hostCommandsCap: "ask",
    updatedBy: admin,
  });
  await database.insert(actionPolicy).values({
    id: "current",
    mode: "dry-run",
    deny: ['page.host == "bank.example.com"'],
    allow: ["true"],
    labels: {
      'page.host == "bank.example.com"': { name: "No bank", description: "" },
    },
    updatedBy: admin,
  });
  await database.insert(capabilitySettings).values([
    {
      scopeKind: "organization",
      scopeId: "",
      capability: "cloudBrowser",
      allowed: false,
      updatedBy: admin,
    },
    {
      scopeKind: "group",
      scopeId: "Sales/EMEA",
      capability: "cloudBrowser",
      allowed: true,
      updatedBy: admin,
    },
  ]);
  await database.insert(networkPolicies).values([
    {
      scopeKind: "organization",
      scopeId: "",
      mode: "allowlist_only",
      rules: { entries: [{ type: "domain", value: "example.com" }] },
      locked: true,
      updatedBy: admin,
    },
  ]);
  await database.insert(approvalPreferences).values({
    ownerUserId: person,
    enabled: true,
    autoReview: true,
    hostCommands: "never",
  });
  await database.insert(approvalRules).values([
    {
      id: id("rule-live"),
      ownerUserId: person,
      botId: bot,
      toolRef: "mcp/gmail/*",
      effect: "write",
      scope: "*",
      behaviour: "allow",
      createdAt: created,
    },
    {
      id: id("rule-revoked"),
      ownerUserId: person,
      botId: "*",
      toolRef: "files/delete",
      effect: "delete",
      scope: "*",
      behaviour: "ask",
      createdAt: created,
      revokedAt: new Date("2026-10-01T00:00:00.000Z"),
    },
  ]);
  await database.insert(approvalTeamRules).values({
    id: id("team-rule"),
    botId: "*",
    toolRef: "mcp/stripe/*",
    effect: "write",
    scope: "*",
    behaviour: "hand_off",
    createdBy: admin,
    createdAt: created,
  });
  await database.insert(sharedUseApprovals).values({
    agentId: bot,
    serverId: app,
    audience: "people",
    outsideInput: false,
    approvedBy: admin,
    approvedAs: null,
    approvedAt: created,
  });
  await database.insert(sharedUseApprovalMembers).values([
    { agentId: bot, serverId: app, kind: "user", value: person },
    { agentId: bot, serverId: app, kind: "group", value: "Sales" },
  ]);
}

beforeAll(async () => {
  cache = await useTestPolicy();
  await database.insert(users).values([
    { id: person, email: `${person}@example.test` },
    { id: admin, email: `${admin}@example.test` },
  ]);
  await database.insert(mcpServers).values({
    id: app,
    title: "Team Gmail",
    vendor: "Composio",
    url: `composio://${app}`,
    provenance: "composio",
    authScheme: "OAUTH2",
    accountMode: "shared",
  });
});

beforeEach(async () => {
  await clearLocal();
  await resetTestPolicy();
});

afterAll(async () => {
  await clearLocal();
  await resetTestPolicy();
  await database.delete(mcpServers).where(eq(mcpServers.id, app));
  await database.delete(users).where(inArray(users.id, [person, admin]));
  await database.$client.close();
});

describe("an upgraded deployment's policy", () => {
  test("is copied into Intelligence, every record with what it had, and the copy records itself", async () => {
    await seedPreviousRelease();
    const outcome = await copyLocalPolicyToIntelligence(database, cache);
    expect(outcome).toMatchObject({ kind: "copied", local: 10 });

    const client = cache.client;
    expect(await client.settings()).toMatchObject({
      ssoRequired: true,
      inactiveEnvironmentDays: 7,
      modelAllowlist: { enabled: true, models: ["openai/gpt-test"] },
      proactiveDailyRuns: 3,
      skillSharing: false,
      approvals: {
        enforceAutoReview: true,
        customRulesEnabled: false,
        hostCommandsCap: "ask",
      },
    });
    expect(await client.actionBoundary()).toMatchObject({
      updatedBy: admin,
      boundary: {
        mode: "dry-run",
        deny: ['page.host == "bank.example.com"'],
        allow: ["true"],
        labels: {
          'page.host == "bank.example.com"': {
            name: "No bank",
            description: "",
          },
        },
      },
    });
    expect(
      (await client.capabilityRules()).items.map((rule) => [
        rule.scopeKind,
        rule.scopeId,
        rule.capability,
        rule.allowed,
      ]),
    ).toEqual([
      ["group", "Sales/EMEA", "cloudBrowser", true],
      ["organization", "", "cloudBrowser", false],
    ]);
    expect((await client.networkRules()).items).toMatchObject([
      {
        scopeKind: "organization",
        mode: "allowlist_only",
        rules: [{ type: "domain", value: "example.com" }],
        locked: true,
      },
    ]);
    expect(await client.approvalPreferences(person)).toMatchObject({
      enabled: true,
      autoReview: true,
      hostCommands: "never",
    });
    const rules = (await client.approvalRules({ includeRevoked: true })).items;
    expect(rules.find((rule) => rule.id === id("rule-live"))).toMatchObject({
      ownerUserId: person,
      agentId: bot,
      tool: "mcp/gmail/*",
      behaviour: "allow",
      createdAt: created.toISOString(),
      revokedAt: null,
    });
    expect(
      rules.find((rule) => rule.id === id("rule-revoked"))?.revokedAt,
    ).toBe("2026-10-01T00:00:00.000Z");
    expect(rules.find((rule) => rule.id === id("team-rule"))).toMatchObject({
      ownerUserId: null,
      behaviour: "hand_off",
      createdBy: admin,
    });
    expect(
      await client.connectionApproval({ agentId: bot, connectionId: app }),
    ).toMatchObject({
      audience: "people",
      approvedAs: "admin",
      approvedBy: admin,
      approvedAt: created.toISOString(),
      members: [
        { kind: "user", value: person },
        { kind: "group", value: "Sales" },
      ],
    });

    // What this server enforces now is what was copied.
    expect(cache.settings().ssoRequired).toBe(true);
    expect(
      cache.approvalRules({ ownerUserId: person }).map((rule) => rule.id),
    ).toEqual([id("rule-live")]);

    const [record] = await database
      .select()
      .from(intelligenceCopies)
      .where(eq(intelligenceCopies.name, POLICY_COPY_NAME));
    expect(record?.copied).toBe(10);
    expect(await copyLocalPolicyToIntelligence(database, cache)).toEqual({
      kind: "done-before",
    });
  });

  test("two replicas copying at once write each record once", async () => {
    await seedPreviousRelease();
    const outcomes = await Promise.all([
      copyLocalPolicyToIntelligence(database, cache),
      copyLocalPolicyToIntelligence(database, cache),
    ]);
    for (const outcome of outcomes)
      expect(["copied", "done-before"]).toContain(outcome.kind);
    const client = cache.client;
    expect((await client.capabilityRules()).items).toHaveLength(2);
    expect(
      (await client.approvalRules({ includeRevoked: true })).items.filter(
        (rule) => rule.id.endsWith(suite),
      ),
    ).toHaveLength(3);
    expect(
      (await client.connectionApprovals({ agentId: bot })).items,
    ).toHaveLength(1);
  });

  test("never writes over what Intelligence already holds", async () => {
    await seedPreviousRelease();
    // A server of this release saved these before the copy ran.
    await cache.patchSettings({ ssoRequired: false, updatedBy: "newer" });
    await cache.putCapabilityRule(
      { scopeKind: "organization", scopeId: "", capability: "cloudBrowser" },
      true,
      "newer",
    );
    await copyLocalPolicyToIntelligence(database, cache);
    const client = cache.client;
    expect((await client.settings()).ssoRequired).toBe(false);
    expect(
      (
        await client.capabilityRule({
          scopeKind: "organization",
          scopeId: "",
          capability: "cloudBrowser",
        })
      )?.allowed,
    ).toBe(true);
    // Everything Intelligence did not have is still copied.
    expect((await client.actionBoundary()).boundary?.mode).toBe("dry-run");
  });

  test("a record Intelligence refuses stops the boot, named, and the copy is not recorded", async () => {
    await seedPreviousRelease();
    await database.insert(capabilitySettings).values({
      scopeKind: "role",
      scopeId: "admin",
      capability: "not a capability name",
      allowed: true,
    });
    await expect(
      copyLocalPolicyToIntelligence(database, cache),
    ).rejects.toThrow(PolicyCopyMismatchError);
    await expect(
      copyLocalPolicyToIntelligence(database, cache),
    ).rejects.toThrow(/not a capability name/);
    expect(
      await database
        .select()
        .from(intelligenceCopies)
        .where(eq(intelligenceCopies.name, POLICY_COPY_NAME)),
    ).toHaveLength(0);
  });

  test("a deployment with no policy of its own copies nothing and records that it ran", async () => {
    expect(await copyLocalPolicyToIntelligence(database, cache)).toMatchObject({
      kind: "copied",
      local: 0,
    });
    expect((await cache.client.settings()).version).toBe(0);
  });
});
