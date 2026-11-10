import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { HeadlessToolSuspension } from "@openbot/toolkit/headless-tools";
import { and, eq, inArray } from "drizzle-orm";
import { createApp } from "../src/app";
import { loadRuleVocabulary } from "../src/approvals/rule-vocabulary";
import { createApprovalService } from "../src/approvals/service";
import { createApprovalStore } from "../src/approvals/store";
import type { ApprovalCandidate } from "../src/approvals/types";
import { createAuditReader } from "../src/audit";
import { loadConfig } from "../src/config";
import { createDatabase } from "../src/db/client";
import {
  agentProfiles,
  agents,
  approvalTeamRules,
  auditEvents,
  mcpServers,
  mcpTools,
} from "../src/db/schema";
import { users } from "../src/db/schema/core";
import { workItems } from "../src/db/schema/work";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import { testEnvironment } from "./support/environment";

/**
 * Team rules written from a description, replayed over history the approval gate really made, and
 * saved as one change.
 *
 * The history is made by the gate itself (`service.gate`), against real tables: a person whose
 * Bot updates a Salesforce opportunity is asked, and says no; then yes; a send from Gmail is asked
 * about by a safety requirement. Then the backtest route replays a rule over the gate's own
 * `approval.evaluated` rows and requests, and the save route adds the rule with one row on the trail.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const suite = randomUUID().slice(0, 8);
const owner = `rules-owner-${suite}`;
const admin = `rules-admin-${suite}`;
const app = `composio-sf${suite}`;
const bot = `agent_rules-${suite}`;
const store = createApprovalStore(database);
const service = createApprovalService(store);
const savedRuleIds: string[] = [];
const ADMIN = {
  id: admin,
  email: `${admin}@example.test`,
  name: "An Administrator",
  image: null,
};

beforeAll(async () => {
  await database.insert(users).values([
    { id: owner, email: `${owner}@example.test` },
    { id: admin, email: ADMIN.email },
  ]);
  await database.insert(mcpServers).values({
    id: app,
    title: "Salesforce",
    vendor: "Composio",
    url: `composio://salesforce-${suite}`,
    provenance: "composio",
    authScheme: "OAUTH2",
    accountMode: "personal",
  });
  await database.insert(mcpTools).values([
    { serverId: app, name: "SALESFORCE_UPDATE_OPPORTUNITY", effect: "write" },
    { serverId: app, name: "SALESFORCE_GET_ACCOUNT", effect: "read" },
  ]);
  await database.insert(agents).values({
    id: bot,
    name: "Sales Assistant",
    type: "built_in",
    configuration: {},
  });
  await database.insert(agentProfiles).values({
    agentId: bot,
    title: "Sales Assistant",
    roleDescription: "",
    avatarSeed: bot,
    visibility: "public",
  });
  // Ask before making changes, so an ordinary update asks: a `default` verdict a rule can change.
  await store.setEnabled(owner, true);
  await service.setPreferences(owner, { enabled: true });
});

afterAll(async () => {
  if (savedRuleIds.length)
    await database
      .delete(approvalTeamRules)
      .where(inArray(approvalTeamRules.id, savedRuleIds));
  await database.delete(workItems).where(
    and(
      eq(workItems.kind, "approval.resume"),
      inArray(
        workItems.key,
        (await store.list(owner)).map((request) => request.id),
      ),
    ),
  );
  await database.delete(mcpServers).where(eq(mcpServers.id, app));
  await database.delete(agents).where(eq(agents.id, bot));
  // Audit rows are append-only by design and stay; they name only this run's throwaway ids.
  await database.delete(users).where(inArray(users.id, [owner, admin]));
  await database.$client.close();
});

function candidate(toolName: string, args: unknown): ApprovalCandidate {
  const toolCallId = randomUUID();
  return {
    actorId: owner,
    botId: bot,
    toolRef: `${app}/${toolName}`,
    effect: "write",
    scope: app,
    args,
    target: {
      serverId: app,
      toolName,
      url: `composio://salesforce`,
      effect: "write",
    },
    continuation: {
      runId: randomUUID(),
      threadId: `rules-thread-${toolCallId}`,
      toolCallId,
      toolName: `${app}/${toolName}`,
      args,
      messages: [],
      state: {},
      context: [],
      forwardedProps: {},
      initiator: { kind: "person" },
    },
  };
}

/** The gate asks about the action; the person answers. */
async function asked(
  toolName: string,
  args: unknown,
  decision: "allow_once" | "deny",
) {
  const suspended = await service.gate(candidate(toolName, args)).then(
    () => false,
    (error: unknown) => error instanceof HeadlessToolSuspension,
  );
  expect(suspended).toBeTrue();
  const [request] = await store.list(owner);
  await service.decide(owner, request?.id as string, decision);
}

function appFor() {
  const args: never[] = Array.from({ length: 35 }) as never[];
  args[0] = loadConfig(testEnvironment()) as never;
  args[1] = {
    handler: () => new Response(null, { status: 204 }),
    api: { getSession: async () => ({ user: ADMIN }) },
  } as never;
  args[2] = { rolesForUser: async () => ["admin"] } as never;
  args[3] = createAuditReader(database) as never;
  args[34] = {
    approvals: service,
    approvalRules: { vocabulary: () => loadRuleVocabulary(database) },
  } as never;
  const build = createApp as (
    ...positional: never[]
  ) => ReturnType<typeof createApp>;
  return build(...args);
}

const post = (path: string, body: unknown) =>
  appFor().request(`http://localhost:3001/api/approvals/team/rules/${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "http://localhost:3001",
    },
    body: JSON.stringify(body),
  });

const allowUpdates = {
  toolRef: `${app}/SALESFORCE_UPDATE_OPPORTUNITY`,
  effect: "write",
  scope: app,
  botId: bot,
  behaviour: "allow",
};

test("a rule replayed over what the gate really decided says which asks it removes, and that a person had denied one", async () => {
  await asked(
    "SALESFORCE_UPDATE_OPPORTUNITY",
    { id: "006A", stage: "Won" },
    "deny",
  );
  await asked(
    "SALESFORCE_UPDATE_OPPORTUNITY",
    { id: "006B", stage: "Lost" },
    "allow_once",
  );

  const response = await post("backtest", { rules: [allowUpdates] });

  expect(response.status).toBe(200);
  const { check, warning, report } = await response.json();
  expect(check).toEqual({ ok: true });
  expect(warning).toBeNull();
  // Two actions, each with a verdict row and a request, counted once each.
  expect(report).toMatchObject({
    matched: 2,
    changed: 2,
    removedAsks: 2,
    removedDenied: 1,
    addedAsks: 0,
    fixed: 0,
  });
  expect(
    report.changes.map((change: { person: string }) => change.person),
  ).toEqual(["deny", "allow_once"]);
  expect(report.changes[0]).toMatchObject({
    bot,
    toolRef: `${app}/SALESFORCE_UPDATE_OPPORTUNITY`,
    was: "ask",
    wasSource: "default",
    would: "allow",
    change: "removes_ask",
    ownerUserId: owner,
  });
  // The verdict rows now name their call, which is what paired them.
  const [row] = await database
    .select()
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.actorUserId, owner),
        eq(auditEvents.eventType, "approval.evaluated"),
      ),
    )
    .limit(1);
  expect(row?.payload).toMatchObject({
    call: { runId: expect.any(String), toolCallId: expect.any(String) },
  });
});

test("rows that don't check are refused by the save, with what is wrong, and nothing is saved", async () => {
  const before = await database
    .select()
    .from(approvalTeamRules)
    .where(eq(approvalTeamRules.botId, bot));

  const response = await post("batch", {
    rules: [{ ...allowUpdates, toolRef: "mcp/salesforce/*" }],
    authoring: { source: "english", text: "Let the sales Bot update deals" },
  });

  expect(response.status).toBe(400);
  const body = await response.json();
  expect(body.error).toContain("no tool here starts with mcp/");
  expect(body.problems).toEqual([
    expect.objectContaining({ row: 1, field: "toolRef" }),
  ]);
  expect(
    await database
      .select()
      .from(approvalTeamRules)
      .where(eq(approvalTeamRules.botId, bot)),
  ).toEqual(before);
});

test("saving rules from a description adds them together, with one row naming who, the rules before and after, and the sentence", async () => {
  const text =
    "Let the sales Bot update opportunities in Salesforce without asking";
  const readRule = {
    toolRef: `${app}/*`,
    effect: "read",
    scope: app,
    botId: bot,
    behaviour: "allow",
  };

  const response = await post("batch", {
    rules: [allowUpdates, readRule],
    authoring: { source: "english", text },
  });

  expect(response.status).toBe(201);
  const { rules } = await response.json();
  expect(rules).toHaveLength(2);
  savedRuleIds.push(...rules.map((rule: { id: string }) => rule.id));

  const [row] = await database
    .select()
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.actorUserId, admin),
        eq(auditEvents.eventType, "approval.rule_changed"),
      ),
    );
  expect(row).toMatchObject({ targetType: "approval_rule", targetId: "team" });
  const payload = row?.payload as {
    change: string;
    layer: string;
    added: { id: string }[];
    before: { id: string }[];
    after: { id: string }[];
    authoring: unknown;
  };
  expect(payload).toMatchObject({
    change: "created",
    layer: "team",
    authoring: { source: "english", text },
  });
  expect(payload.added).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ ...allowUpdates }),
      expect.objectContaining({ ...readRule }),
    ]),
  );
  const ids = rules.map((rule: { id: string }) => rule.id).sort();
  expect(payload.before.map((rule) => rule.id)).not.toContain(ids[0]);
  expect(
    payload.after
      .map((rule) => rule.id)
      .filter((id) => ids.includes(id))
      .sort(),
  ).toEqual(ids);
  expect(payload.after.length - payload.before.length).toBe(2);

  // In force: the next update by this Bot is allowed by the team rule, without asking.
  await expect(
    service.gate(candidate("SALESFORCE_UPDATE_OPPORTUNITY", { id: "006C" })),
  ).resolves.toBeUndefined();
});
