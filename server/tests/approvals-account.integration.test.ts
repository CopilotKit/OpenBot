import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { approvalWords } from "@openbot/shared/tool-name";
import { and, eq, inArray } from "drizzle-orm";
import { ruleMatches, strictestRule } from "../src/approvals/policy";
import { equivalenceOf } from "../src/approvals/service";
import { createApprovalStore } from "../src/approvals/store";
import {
  type ApprovalCandidate,
  type ApprovalRule,
  approvalAction,
} from "../src/approvals/types";
import { createDatabase } from "../src/db/client";
import { approvalRules, users } from "../src/db/schema";
import { workItems } from "../src/db/schema/work";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * AN APPROVAL FOR ONE MAILBOX NEVER COVERS ANOTHER.
 *
 * A person with two Gmail accounts asked a Bot to send from their work address and pressed "Always
 * allow here". The same send from their personal address is a different request: it is not the
 * equivalent of the first, its digest is not the first's, and the rule saved for the work address
 * does not allow it. The card names the account it is asking about.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const prefix = `approval-account-${randomUUID()}`;
const owner = `${prefix}-owner`;
const store = createApprovalStore(database);
const keys: string[] = [];
const WORK = "dana@work.example";
const HOME = "dana.home@gmail.example";

beforeAll(async () => {
  await database
    .insert(users)
    .values([{ id: owner, email: `${owner}@example.test` }]);
  await store.setEnabled(owner, true);
});

afterAll(async () => {
  if (keys.length)
    await database
      .delete(workItems)
      .where(
        and(
          eq(workItems.kind, "approval.resume"),
          inArray(workItems.key, keys),
        ),
      );
  await database.delete(users).where(eq(users.id, owner));
  await database.$client.close();
});

/** One Gmail send for the owner, from `account`, otherwise identical every time. */
function send(account?: string): ApprovalCandidate {
  const args = { to: "pat@example.test", subject: "Hi", body: "See you." };
  return {
    actorId: owner,
    botId: `${prefix}-bot`,
    toolRef: "gmail/GMAIL_SEND_EMAIL",
    effect: "write",
    scope: "gmail",
    args,
    target: { serverId: "gmail", toolName: "GMAIL_SEND_EMAIL" },
    ...(account ? { account } : {}),
    continuation: {
      runId: randomUUID(),
      threadId: `${prefix}-thread`,
      toolCallId: randomUUID(),
      toolName: "gmail__GMAIL_SEND_EMAIL",
      args,
      messages: [],
      state: {},
      context: [],
      forwardedProps: {},
    },
  };
}

test("two otherwise identical calls to different accounts are different requests", () => {
  const fromWork = send(WORK);
  const fromHome = { ...send(HOME), continuation: fromWork.continuation };

  expect(equivalenceOf(fromWork)).not.toBe(equivalenceOf(fromHome));
  expect(approvalAction(fromWork).actionDigest).not.toBe(
    approvalAction(fromHome).actionDigest,
  );
  // And the same account twice is the same request, which is what the comparison is for.
  expect(equivalenceOf(fromWork)).toBe(
    equivalenceOf({ ...send(WORK), continuation: fromWork.continuation }),
  );
  // A call that names no account hashes as it always did.
  expect(equivalenceOf(send())).toBe(
    equivalenceOf({ ...send(), account: undefined }),
  );
});

test("Always allow here for one account is saved for that account, and does not allow another", async () => {
  const first = await store.open(approvalAction(send(WORK)));
  keys.push(first.id);
  await store.decide(owner, first.id, "allow_always");

  const [saved] = await database
    .select()
    .from(approvalRules)
    .where(eq(approvalRules.ownerUserId, owner));
  expect(saved?.account).toBe(WORK);

  const againFromWork = await store.open(approvalAction(send(WORK)));
  keys.push(againFromWork.id);
  expect(againFromWork.status).toBe("approved");

  const fromHome = await store.open(approvalAction(send(HOME)));
  keys.push(fromHome.id);
  expect(fromHome.status).toBe("pending");

  // The policy layer reads the same rule the same way.
  const rules = await store.rules(owner);
  expect(strictestRule(send(WORK), [], rules)?.rule.behaviour).toBe("allow");
  expect(strictestRule(send(HOME), [], rules)).toBeUndefined();
});

test("a personal allow rule naming no account no longer allows a call that names one; asking still holds everywhere", () => {
  const rule = (
    behaviour: ApprovalRule["behaviour"],
    account: string | null = null,
  ) => ({
    id: randomUUID(),
    botId: "*",
    toolRef: "gmail/*",
    effect: "write",
    scope: "gmail",
    behaviour,
    account,
  });

  // Written before the person had a second account, so not consent for a mailbox it never saw.
  expect(ruleMatches(rule("allow"), send(HOME))).toBe(false);
  expect(ruleMatches(rule("pre_approved"), send(HOME))).toBe(false);
  // It still covers a call that names no account, as it always did.
  expect(ruleMatches(rule("allow"), send())).toBe(true);
  // The strict behaviours hold for every account.
  expect(ruleMatches(rule("ask"), send(HOME))).toBe(true);
  expect(ruleMatches(rule("hand_off"), send(HOME))).toBe(true);
  // A team rule is the admin's policy for the app, whichever account.
  expect(ruleMatches(rule("allow"), send(HOME), "team_rule")).toBe(true);
  // A rule for one account is about that account only, in either layer.
  expect(ruleMatches(rule("ask", WORK), send(HOME), "team_rule")).toBe(false);
  expect(ruleMatches(rule("allow", WORK), send(WORK))).toBe(true);
});

test("the card names the account it is asking about", () => {
  const words = approvalWords({
    toolRef: "gmail/GMAIL_SEND_EMAIL",
    scope: "gmail",
    account: WORK,
  });
  expect(`${words.action} on ${words.place}`).toBe(
    `send email from ${WORK} on Gmail`,
  );
  // With one account there is nothing to tell apart, and the card reads as it did.
  const single = approvalWords({
    toolRef: "gmail/GMAIL_SEND_EMAIL",
    scope: "gmail",
  });
  expect(`${single.action} on ${single.place}`).toBe("send email on Gmail");
});
