import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { offersStandingRule } from "@openbot/shared/standing-rule";
import { HeadlessToolSuspension } from "@openbot/toolkit/headless-tools";
import { and, eq, inArray, sql } from "drizzle-orm";
import { createApprovalService } from "../src/approvals/service";
import { createApprovalStore } from "../src/approvals/store";
import {
  type ApprovalCandidate,
  withApprovalContext,
} from "../src/approvals/types";
import { createDatabase } from "../src/db/client";
import {
  approvalConversationGrants,
  approvalRequests,
  approvalTeamRules,
  approvalTeamSettings,
} from "../src/db/schema/approvals";
import {
  auditEvents,
  channels,
  intelligenceChannelMappings,
  users,
} from "../src/db/schema/core";
import { workItems } from "../src/db/schema/work";
import { setEdition } from "../src/edition";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * OPEN BY DEFAULT, through the real gate, policy and store: sending, deleting, sharing, posting and
 * paying ask, and the person can answer Allow once, Allow for this conversation, or Always allow here.
 * An admin closes a kind for everybody. This reverses #998, which offered Allow once and Deny only.
 *
 * The ask that started it: approving every message in a back-and-forth on Slack is tiring.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const prefix = `open-${randomUUID()}`;
const people: string[] = [];
const channelIds: string[] = [];
const teamRuleIds: string[] = [];
const admin = `${prefix}-admin`;
const store = createApprovalStore(database);
const service = createApprovalService(store);
let priorTeam: typeof approvalTeamSettings.$inferSelect | undefined;

async function person() {
  const id = `${prefix}-${people.length}`;
  await database.insert(users).values({ id, email: `${id}@example.test` });
  people.push(id);
  return id;
}

/** A connector call, as `plugins/plugin-store/calls.ts` puts it to the gate. */
const tool = (
  server: string,
  name: string,
  args: Record<string, unknown>,
  botId = `${prefix}-bot`,
): Omit<ApprovalCandidate, "actorId"> => ({
  botId,
  toolRef: `${server}/${name}`,
  effect: "write",
  scope: server,
  args,
  target: {
    serverId: server,
    toolName: name,
    url: `composio://${server}`,
    effect: "write",
  },
});

const slackSend = (text: string, botId?: string) =>
  tool(
    "composio-slack",
    "SLACK_SEND_MESSAGE",
    { channel: "C0PROJECT", text },
    botId,
  );

/** Runs the gate in `threadId`: undefined if it ran, the waiting request if it asked. */
async function gate(
  actorId: string,
  threadId: string,
  action: Omit<ApprovalCandidate, "actorId">,
) {
  const toolCallId = randomUUID();
  const outcome = await withApprovalContext(
    {
      runId: randomUUID(),
      threadId,
      toolCallId,
      toolName: action.toolRef,
      args: action.args as Record<string, unknown>,
      messages: [{ id: "u1", role: "user", content: "Keep the team posted." }],
      state: {},
      context: [],
      forwardedProps: {},
    },
    () => service.gate({ ...action, actorId }),
  ).then(
    () => undefined,
    (error: unknown) => {
      if (!(error instanceof HeadlessToolSuspension)) throw error;
      return error;
    },
  );
  if (!outcome) return undefined;
  const [request] = (await store.list(actorId)).filter(
    (row) => row.action.toolCallId === toolCallId,
  );
  if (!request) throw new Error("The gate suspended without a request.");
  return request;
}

/** The gate's verdicts on this person's actions, newest last. */
async function verdicts(owner: string) {
  const rows = await database
    .select()
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.actorUserId, owner),
        eq(auditEvents.eventType, "approval.evaluated"),
      ),
    )
    .orderBy(auditEvents.createdAt);
  return rows.map(
    (row) =>
      (row.payload as { outcome: Record<string, unknown> }).outcome as {
        behaviour: string;
        source: string;
        kind?: string;
        reason: string;
      },
  );
}

const thread = () => `${prefix}-thread-${randomUUID()}`;

beforeAll(async () => {
  setEdition("team");
  await database.insert(users).values({ id: admin, email: `${admin}@x.test` });
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
  if (people.length) {
    const decided = await database
      .select({ id: approvalRequests.id })
      .from(approvalRequests)
      .where(inArray(approvalRequests.ownerUserId, people));
    if (decided.length)
      await database.delete(workItems).where(
        and(
          eq(workItems.kind, "approval.resume"),
          inArray(
            workItems.key,
            decided.map((request) => request.id),
          ),
        ),
      );
    await database
      .delete(approvalRequests)
      .where(inArray(approvalRequests.ownerUserId, people));
  }
  if (channelIds.length)
    await database.delete(channels).where(inArray(channels.id, channelIds));
  await database.delete(users).where(inArray(users.id, [...people, admin]));
  await database.$client.close();
});

describe("Allow for this conversation", () => {
  test("later sends of the same tool in the same conversation run without a card, each on the audit trail", async () => {
    const owner = await person();
    const here = thread();
    const first = await gate(owner, here, slackSend("Draft is up."));
    expect(first?.action.policy).toMatchObject({
      behaviour: "ask",
      source: "safety",
      kind: "sending",
      reason: "Sending something to other people asks you first.",
    });
    expect(offersStandingRule(first?.action ?? {})).toBeTrue();
    await service.decide(owner, first?.id ?? "", "allow_conversation");

    expect(await gate(owner, here, slackSend("Review at 3."))).toBeUndefined();
    expect(await gate(owner, here, slackSend("Merged."))).toBeUndefined();

    const allowed = (await verdicts(owner)).filter(
      (outcome) => outcome.source === "conversation",
    );
    expect(allowed).toHaveLength(2);
    for (const outcome of allowed)
      expect(outcome).toMatchObject({
        behaviour: "allow",
        kind: "sending",
        reason: "You allowed this for this conversation.",
      });
    const [answer] = await database
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.actorUserId, owner),
          eq(auditEvents.eventType, "approval.person_decided"),
        ),
      );
    expect(answer?.payload).toMatchObject({ decision: "allow_conversation" });
    // The conversation shows what it allows, to turn it off.
    const inbox = await service.inbox(owner);
    expect(inbox.conversationGrants).toEqual([
      expect.objectContaining({
        threadId: here,
        toolRef: "composio-slack/SLACK_SEND_MESSAGE",
        kind: "sending",
      }),
    ]);
  });

  test("it doesn't carry to another conversation, another tool or another Bot", async () => {
    const owner = await person();
    const here = thread();
    const first = await gate(owner, here, slackSend("Draft is up."));
    await service.decide(owner, first?.id ?? "", "allow_conversation");

    expect(
      await gate(owner, thread(), slackSend("Hello there.")),
    ).toMatchObject({ status: "pending" });
    expect(
      await gate(
        owner,
        here,
        tool("composio-slack", "SLACK_DELETE_A_MESSAGE", {
          channel: "C0PROJECT",
          ts: "1.2",
        }),
      ),
    ).toMatchObject({ status: "pending" });
    expect(
      await gate(
        owner,
        here,
        slackSend("From another Bot.", `${prefix}-other`),
      ),
    ).toMatchObject({ status: "pending" });
    // Nobody else's conversation answer is theirs.
    const somebody = await person();
    expect(await gate(somebody, here, slackSend("Mine?"))).toMatchObject({
      status: "pending",
    });
  });

  test("it ends when turned off, and when the conversation is deleted", async () => {
    const owner = await person();
    const here = thread();
    const first = await gate(owner, here, slackSend("Draft is up."));
    await service.decide(owner, first?.id ?? "", "allow_conversation");
    expect(await gate(owner, here, slackSend("Again."))).toBeUndefined();

    const [grant] = (await service.inbox(owner)).conversationGrants;
    await service.revokeConversationGrant(owner, grant?.id ?? "");
    expect(await gate(owner, here, slackSend("And again."))).toMatchObject({
      status: "pending",
    });
    const [revoked] = await database
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.actorUserId, owner),
          eq(auditEvents.eventType, "approval.rule_changed"),
        ),
      );
    expect(revoked?.payload).toMatchObject({
      change: "revoked",
      layer: "conversation",
    });

    // A conversation's answers end with it.
    const channelId = `${prefix}-channel-${channelIds.length}`;
    channelIds.push(channelId);
    const elsewhere = thread();
    await database
      .insert(channels)
      .values({ id: channelId, name: "Launch", description: "" });
    await database
      .insert(intelligenceChannelMappings)
      .values({ userId: owner, channelId, threadId: elsewhere });
    const asked = await gate(owner, elsewhere, slackSend("Hi."));
    await service.decide(owner, asked?.id ?? "", "allow_conversation");
    expect(
      await gate(owner, elsewhere, slackSend("Hi again.")),
    ).toBeUndefined();
    await database
      .update(channels)
      .set({ deletedAt: sql`now()` })
      .where(eq(channels.id, channelId));
    expect(await gate(owner, elsewhere, slackSend("Still?"))).toMatchObject({
      status: "pending",
    });
    expect((await service.inbox(owner)).conversationGrants).toEqual([]);
  });
});

describe("Always allow here, on a send", () => {
  test("is offered, saved for sends of that tool, and honoured in any conversation, with audit rows", async () => {
    const owner = await person();
    const first = await gate(owner, thread(), slackSend("Draft is up."));
    await service.decide(owner, first?.id ?? "", "allow_always");
    expect(await store.rules(owner)).toEqual([
      expect.objectContaining({
        toolRef: "composio-slack/SLACK_SEND_MESSAGE",
        behaviour: "allow",
        kind: "sending",
      }),
    ]);
    expect(await gate(owner, thread(), slackSend("Merged."))).toBeUndefined();
    expect((await verdicts(owner)).at(-1)).toMatchObject({
      behaviour: "allow",
      source: "personal_rule",
      kind: "sending",
    });
  });

  test("an allow written about something else doesn't reach a send", async () => {
    const owner = await person();
    await service.createRule(owner, {
      botId: "*",
      toolRef: "composio-slack/*",
      effect: "*",
      scope: "*",
      behaviour: "allow",
    });
    // The rule still allows an ordinary Slack change...
    expect(
      await gate(
        owner,
        thread(),
        tool("composio-slack", "SLACK_ADD_REACTION_TO_AN_ITEM", {
          name: "eyes",
        }),
      ),
    ).toBeUndefined();
    // ...and a send still asks, as it did before it.
    expect(await gate(owner, thread(), slackSend("Hi."))).toMatchObject({
      status: "pending",
    });
  });
});

describe("an admin closes a kind", () => {
  test("sending set to ask every time asks over the person's answers, and offers Allow once and Deny only", async () => {
    const owner = await person();
    const here = thread();
    const first = await gate(owner, here, slackSend("Draft is up."));
    await service.decide(owner, first?.id ?? "", "allow_conversation");
    const other = await gate(owner, thread(), slackSend("Elsewhere."));
    await service.decide(owner, other?.id ?? "", "allow_always");
    expect(await gate(owner, here, slackSend("Open."))).toBeUndefined();

    await service.setTeamSettings(admin, { actionKinds: { sending: "ask" } });
    const closed = await gate(owner, here, slackSend("Closed."));
    expect(closed?.action.policy).toMatchObject({
      behaviour: "ask",
      source: "safety",
      kind: "sending",
      closed: true,
    });
    expect(offersStandingRule(closed?.action ?? {})).toBeFalse();
    await expect(
      service.decide(owner, closed?.id ?? "", "allow_conversation"),
    ).rejects.toThrow("ask every time");
    await expect(
      service.decide(owner, closed?.id ?? "", "allow_always"),
    ).rejects.toThrow("ask every time");
    expect(
      (await service.decide(owner, closed?.id ?? "", "allow_once")).status,
    ).toBe("approved");
    // Other kinds stay open.
    const deleting = await gate(
      owner,
      here,
      tool("composio-slack", "SLACK_DELETE_A_MESSAGE", { ts: "1.2" }),
    );
    expect(offersStandingRule(deleting?.action ?? {})).toBeTrue();

    await service.setTeamSettings(admin, {
      actionKinds: { sending: "hand_off" },
    });
    expect(
      (await gate(owner, here, slackSend("Yours.")))?.action.policy,
    ).toMatchObject({ behaviour: "hand_off", kind: "sending" });

    await service.setTeamSettings(admin, { actionKinds: { sending: "open" } });
    expect(await gate(owner, here, slackSend("Open again."))).toBeUndefined();
  });

  test("a team rule that asks beats the person's conversation answer", async () => {
    const owner = await person();
    const here = thread();
    const first = await gate(owner, here, slackSend("Draft is up."));
    await service.decide(owner, first?.id ?? "", "allow_conversation");
    const rule = await service.createTeamRule(admin, {
      botId: "*",
      toolRef: "composio-slack/SLACK_SEND_MESSAGE",
      effect: "*",
      scope: "*",
      behaviour: "ask",
    });
    teamRuleIds.push(rule.id);
    expect(
      (await gate(owner, here, slackSend("Asked.")))?.action.policy,
    ).toMatchObject({ behaviour: "ask", source: "team_rule" });
    await service.revokeTeamRule(admin, rule.id);
    expect(await gate(owner, here, slackSend("Allowed."))).toBeUndefined();
  });
});

test("payments ask with every answer; a password typed on a website stays the person's", async () => {
  const owner = await person();
  const paying = await gate(
    owner,
    thread(),
    tool("composio-stripe", "STRIPE_PAY_INVOICE", { invoice: "in_1" }),
  );
  expect(paying?.action.policy).toMatchObject({
    behaviour: "ask",
    kind: "payments",
  });
  expect(offersStandingRule(paying?.action ?? {})).toBeTrue();

  const typed = await gate(owner, thread(), {
    botId: `${prefix}-bot`,
    toolRef: "computer_type",
    effect: "write",
    scope: "accounts.example.com",
    args: { ref: "e3", text: "hunter2" },
    target: {
      pageUrl: "https://accounts.example.com/change",
      element: { ref: "e3", role: "textbox", name: "New password" },
    },
  });
  expect(typed?.action.policy).toMatchObject({
    behaviour: "hand_off",
    kind: "credentials",
  });
  expect(offersStandingRule(typed?.action ?? {})).toBeFalse();
  await expect(
    service.decide(owner, typed?.id ?? "", "allow_conversation"),
  ).rejects.toThrow("handed to you");
  expect(
    await database
      .select()
      .from(approvalConversationGrants)
      .where(eq(approvalConversationGrants.ownerUserId, owner)),
  ).toEqual([]);
});
