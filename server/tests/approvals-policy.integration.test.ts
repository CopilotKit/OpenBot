import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import {
  createApprovalService,
  HANDLED_BY_PERSON,
} from "../src/approvals/service";
import { createApprovalStore } from "../src/approvals/store";
import type { ApprovalCandidate } from "../src/approvals/types";
import { HeadlessToolSuspension } from "../src/computer/headless-tools";
import { createDatabase } from "../src/db/client";
import {
  approvalTeamRules,
  approvalTeamSettings,
  auditEvents,
} from "../src/db/schema";
import { users } from "../src/db/schema/core";
import { workItems } from "../src/db/schema/work";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * Rules, team settings, hand-offs and the audit trail, against real tables. Needs a database with
 * the TS schema applied (the coordinator's generated migration, or `drizzle-kit push` on a scratch
 * database). The team settings row is deployment-wide, so this file restores it afterwards.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const prefix = `policy-${randomUUID()}`;
const owner = `${prefix}-owner`;
const admin = `${prefix}-admin`;
const store = createApprovalStore(database);
const service = createApprovalService(store);
const teamRuleIds: string[] = [];
let priorTeam: typeof approvalTeamSettings.$inferSelect | undefined;

beforeAll(async () => {
  await database.insert(users).values([
    { id: owner, email: `${owner}@example.test` },
    { id: admin, email: `${admin}@example.test` },
  ]);
  [priorTeam] = await database
    .select()
    .from(approvalTeamSettings)
    .where(eq(approvalTeamSettings.id, "team"));
});
afterAll(async () => {
  if (teamRuleIds.length)
    await database
      .delete(approvalTeamRules)
      .where(inArray(approvalTeamRules.id, teamRuleIds));
  await database
    .delete(approvalTeamSettings)
    .where(eq(approvalTeamSettings.id, "team"));
  if (priorTeam) await database.insert(approvalTeamSettings).values(priorTeam);
  await database.delete(workItems).where(
    and(
      eq(workItems.kind, "approval.resume"),
      inArray(
        workItems.key,
        (await store.list(owner)).map((request) => request.id),
      ),
    ),
  );
  // Audit rows are append-only by design and stay; they name only this run's throwaway ids.
  await database.delete(users).where(inArray(users.id, [owner, admin]));
  await database.$client.close();
});

function candidate(over: Partial<ApprovalCandidate> = {}): ApprovalCandidate {
  const toolCallId = randomUUID();
  return {
    actorId: owner,
    botId: `${prefix}-bot`,
    toolRef: "mcp/gmail/send_email",
    effect: "write",
    scope: "gmail",
    args: { to: "sam@example.com" },
    continuation: {
      runId: randomUUID(),
      // Its own conversation, so earlier answers in this file do not apply to it.
      threadId: `${prefix}-thread-${toolCallId}`,
      toolCallId,
      toolName: "mcp/gmail/send_email",
      args: { to: "sam@example.com" },
      messages: [],
      state: {},
      context: [],
      forwardedProps: {},
      initiator: { kind: "routine", id: `${prefix}-routine` },
    },
    ...over,
  };
}

const suspends = (promise: Promise<unknown>) =>
  promise.then(
    () => false,
    (error: unknown) => error instanceof HeadlessToolSuspension,
  );

test("personal and team rules layer, the strictest wins, and switching custom rules off keeps team rules", async () => {
  await service.createRule(owner, {
    botId: "*",
    toolRef: "mcp/gmail/*",
    effect: "*",
    scope: "*",
    behaviour: "allow",
  });
  await expect(service.gate(candidate())).resolves.toBeUndefined();

  const locked = await service.createTeamRule(admin, {
    botId: "*",
    toolRef: "mcp/gmail/send_*",
    effect: "write",
    scope: "*",
    behaviour: "ask",
  });
  teamRuleIds.push(locked.id);
  expect(await suspends(service.gate(candidate()))).toBeTrue();

  await service.setTeamSettings(admin, { customRulesEnabled: false });
  await expect(
    service.createRule(owner, {
      botId: "*",
      toolRef: "*",
      effect: "*",
      scope: "*",
      behaviour: "allow",
    }),
  ).rejects.toThrow("switched custom rules off");
  await service.revokeTeamRule(admin, locked.id);
  // Personal allow no longer applies; with no preference that is the default (allow).
  await expect(service.gate(candidate())).resolves.toBeUndefined();
  await service.setTeamSettings(admin, { customRulesEnabled: true });

  const inbox = await service.inbox(owner);
  expect(inbox.rules.map((rule) => rule.behaviour)).toContain("allow");
  expect(inbox.team).toMatchObject({ customRulesEnabled: true });
});

test("a safety hand-off is stored, cannot be allowed, and is marked done by the person", async () => {
  const paying = candidate({
    toolRef: "computer_click",
    args: { element: "Pay now" },
  });
  expect(await suspends(service.gate(paying))).toBeTrue();
  const [request] = (await store.list(owner)).filter(
    (row) => row.action.toolCallId === paying.continuation?.toolCallId,
  );
  expect(request?.action.policy).toMatchObject({
    behaviour: "hand_off",
    source: "safety",
  });
  await expect(
    service.decide(owner, request?.id as string, "allow_always"),
  ).rejects.toThrow("handed to you");
  const decided = await service.decide(owner, request?.id as string, "handled");
  expect(decided.decision).toBe("handled");
  await expect(service.gate(paying)).resolves.toMatchObject({
    replay: HANDLED_BY_PERSON,
  });
});

test("'Always allow here' saves a personal allow rule that the gate then honours", async () => {
  await store.policy?.setPreferences(owner, { enabled: true });
  await store.setEnabled(owner, true);
  const first = candidate({ toolRef: "mcp/drive/share", scope: "drive" });
  expect(await suspends(service.gate(first))).toBeTrue();
  const [request] = (await store.list(owner)).filter(
    (row) => row.action.toolCallId === first.continuation?.toolCallId,
  );
  expect(request?.action.policy?.behaviour).toBe("ask");
  await service.decide(owner, request?.id as string, "allow_always");
  const rules = await store.rules(owner);
  expect(rules).toContainEqual(
    expect.objectContaining({ toolRef: "mcp/drive/share", behaviour: "allow" }),
  );
  await expect(
    service.gate(candidate({ toolRef: "mcp/drive/share", scope: "drive" })),
  ).resolves.toBeUndefined();
  await store.setEnabled(owner, false);
});

test("every non-trivial verdict is on the audit trail with its initiator", async () => {
  const rows = await database
    .select()
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.actorUserId, owner),
        eq(auditEvents.eventType, "approval.evaluated"),
      ),
    );
  expect(rows.length).toBeGreaterThanOrEqual(4);
  expect(rows).toContainEqual(
    expect.objectContaining({
      initiatorKind: "routine",
      initiatorId: `${prefix}-routine`,
      payload: expect.objectContaining({
        outcome: expect.objectContaining({ source: "safety" }),
      }),
    }),
  );
  const changes = await database
    .select()
    .from(auditEvents)
    .where(eq(auditEvents.actorUserId, admin));
  expect(changes.map((row) => row.eventType)).toEqual(
    expect.arrayContaining([
      "approval.rule_changed",
      "approval.settings_changed",
    ]),
  );
});

test("host commands: the member's setting under the team cap, stricter wins", async () => {
  await service.setPreferences(owner, { hostCommands: "allow" });
  await service.setTeamSettings(admin, { hostCommandsCap: "ask" });
  expect(await service.hostCommandPolicy(owner)).toBe("ask");
  await service.setPreferences(owner, { hostCommands: "never" });
  expect(await service.hostCommandPolicy(owner)).toBe("never");
  await service.setTeamSettings(admin, { hostCommandsCap: "allow" });
  await service.setPreferences(owner, { hostCommands: "allow" });
  expect(await service.hostCommandPolicy(owner)).toBe("allow");
});

test("a saved rule is changed in place, only by its owner, and the change is on the trail", async () => {
  const rule = await service.createRule(owner, {
    botId: "*",
    toolRef: "mcp/calendar/*",
    effect: "*",
    scope: "*",
    behaviour: "allow",
  });
  await expect(
    service.updateRule(admin, rule.id, { behaviour: "hand_off" }),
  ).rejects.toThrow("could not be found");
  const changed = await service.updateRule(owner, rule.id, {
    behaviour: "ask",
  });
  expect(changed).toMatchObject({ id: rule.id, behaviour: "ask" });
  expect(
    await suspends(
      service.gate(candidate({ toolRef: "mcp/calendar/create_event" })),
    ),
  ).toBeTrue();
  const locked = await service.createTeamRule(admin, {
    botId: "*",
    toolRef: "mcp/crm/*",
    effect: "*",
    scope: "*",
    behaviour: "ask",
  });
  teamRuleIds.push(locked.id);
  await expect(
    service.updateTeamRule(admin, locked.id, { behaviour: "hand_off" }),
  ).resolves.toMatchObject({ behaviour: "hand_off" });
  const rows = await database
    .select()
    .from(auditEvents)
    .where(eq(auditEvents.eventType, "approval.rule_changed"));
  expect(
    rows.filter(
      (row) =>
        (row.targetId === rule.id || row.targetId === locked.id) &&
        (row.payload as { change?: string }).change === "updated",
    ),
  ).toHaveLength(2);
});

test("declining one connector call does not decline a different call to the same tool", async () => {
  await store.setEnabled(owner, true);
  const thread = `${prefix}-thread-equivalence`;
  const email = (to: string) => {
    const base = candidate();
    return candidate({
      // A tool no other test here has a rule for.
      toolRef: "mcp/mailer/send_email",
      scope: "mailer",
      args: { to, body: "hello" },
      // The connector target, as `plugins/store.ts` builds it: it names the tool, not the call.
      target: {
        serverId: "mailer",
        toolName: "send_email",
        url: "https://mailer.example",
        effect: "write",
      },
      continuation: {
        ...(base.continuation as NonNullable<
          ApprovalCandidate["continuation"]
        >),
        threadId: thread,
        args: { to, body: "hello" },
      },
    });
  };
  const first = email("a@example.test");
  expect(await suspends(service.gate(first))).toBeTrue();
  const [request] = (await store.list(owner)).filter(
    (row) => row.action.toolCallId === first.continuation?.toolCallId,
  );
  await service.decide(owner, request?.id as string, "deny");
  // The same call again, in the same conversation, is still declined.
  await expect(service.gate(email("a@example.test"))).rejects.toThrow(
    "declined",
  );
  // A different recipient is a different action: it is asked about, not refused as declined.
  expect(await suspends(service.gate(email("b@example.test")))).toBeTrue();
  await store.setEnabled(owner, false);
});
