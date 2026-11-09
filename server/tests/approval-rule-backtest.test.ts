import { describe, expect, test } from "bun:test";
import {
  backtestApprovalRules,
  recordedActions,
} from "../src/approvals/rule-backtest";
import type {
  ApprovalPolicyOutcome,
  ApprovalRecord,
  ApprovalRuleInput,
} from "../src/approvals/types";
import type { AuditEvent } from "../src/audit";

/**
 * Candidate team rules replayed over the approval gate's own history: the `approval.evaluated` rows
 * it writes (shaped as `recordDecision` writes them) and the requests people answered (shaped as
 * `open` and `decide` leave them). Real-shaped rows from a week of three Bots, two people, Gmail,
 * Salesforce and Slack.
 */

const ANA = "user-ana";
const BEN = "user-ben";
const RESEARCH = "agent_0b6c1d2e-7a44-4a0e-9a59-2f0d5c3e8b11";
const SALES = "agent_5e2f8a90-1c3b-4d6e-8f70-a1b2c3d4e5f6";
const INBOX = "agent_9d8c7b6a-5f4e-4d3c-b2a1-0f9e8d7c6b5a";

const at = (minute: number, second = 0) =>
  new Date(Date.UTC(2026, 10, 9, 15, minute, second));

type Action = {
  key: string;
  owner: string;
  bot: string;
  toolRef: string;
  effect: string;
  scope: string;
  outcome: ApprovalPolicyOutcome;
  minute: number;
  second?: number;
  initiator?: { kind: string; id: string | null };
  /** The person's answer, where the gate asked. */
  answer?: ApprovalRecord["decision"] | "pending";
  /** The verdict row carries the call it is about (rows written since pairing existed). */
  withCall?: boolean;
  /** The verdict row fell outside the slice read. */
  noVerdict?: boolean;
  target?: unknown;
};

const outcome = (
  behaviour: ApprovalPolicyOutcome["behaviour"],
  source: ApprovalPolicyOutcome["source"],
  extra: Partial<ApprovalPolicyOutcome> = {},
): ApprovalPolicyOutcome => ({
  behaviour,
  source,
  reason: "recorded",
  ...extra,
});

/** The gate's verdict row, as `recordDecision` writes it. */
function verdict(action: Action): AuditEvent {
  return {
    id: `audit-${action.key}`,
    actorUserId: action.owner,
    initiatorKind: action.initiator?.kind ?? "person",
    initiatorId: action.initiator?.id ?? null,
    eventType: "approval.evaluated",
    targetType: "approval",
    targetId: action.toolRef,
    createdAt: at(action.minute, action.second).toISOString(),
    payload: {
      decidedBy: "policy",
      bot: action.bot,
      tool: action.toolRef,
      effect: action.effect,
      scope: action.scope,
      outcome: action.outcome,
      ...(action.withCall
        ? {
            call: {
              runId: `run-${action.key}`,
              toolCallId: `call-${action.key}`,
            },
          }
        : {}),
    },
  };
}

/** The request the gate opened for it, as `open` and then `decide` leave it. */
function request(action: Action): ApprovalRecord {
  const decided = action.answer && action.answer !== "pending";
  return {
    id: `request-${action.key}`,
    ownerUserId: action.owner,
    action: {
      actorId: action.owner,
      botId: action.bot,
      toolRef: action.toolRef,
      effect: action.effect,
      scope: action.scope,
      args: { note: "args as the Bot sent them" },
      target: action.target ?? {
        serverId: action.scope,
        effect: action.effect,
      },
      runId: `run-${action.key}`,
      threadId: `thread-${action.key}`,
      toolCallId: `call-${action.key}`,
      actionDigest: `digest-${action.key}`,
      policy: action.outcome,
    },
    status: decided
      ? action.answer === "deny"
        ? "denied"
        : "completed"
      : "pending",
    decision: decided ? (action.answer as ApprovalRecord["decision"]) : null,
    result: null,
    // Opened a moment after the verdict, as `gate` writes the row and then opens the request.
    createdAt: at(action.minute, (action.second ?? 0) + 1),
    decidedAt: decided ? at(action.minute + 1) : null,
    consumedAt: null,
    completedAt: null,
  };
}

const WEEK: Action[] = [
  {
    key: "send-1",
    owner: ANA,
    bot: INBOX,
    toolRef: "composio-gmail/GMAIL_SEND_EMAIL",
    effect: "write",
    scope: "composio-gmail",
    outcome: outcome("ask", "safety"),
    minute: 1,
    answer: "deny",
    withCall: true,
  },
  {
    key: "opp-1",
    owner: BEN,
    bot: SALES,
    toolRef: "composio-salesforce/SALESFORCE_UPDATE_OPPORTUNITY",
    effect: "write",
    scope: "composio-salesforce",
    outcome: outcome("ask", "default"),
    minute: 2,
    answer: "allow_once",
    withCall: true,
  },
  {
    // Written before verdict rows named their call: paired by who, what and when.
    key: "opp-2",
    owner: BEN,
    bot: SALES,
    toolRef: "composio-salesforce/SALESFORCE_UPDATE_OPPORTUNITY",
    effect: "write",
    scope: "composio-salesforce",
    outcome: outcome("ask", "default"),
    minute: 3,
    answer: "deny",
  },
  {
    // The same action again a moment later, also older: each request pairs with its own verdict.
    key: "opp-3",
    owner: BEN,
    bot: SALES,
    toolRef: "composio-salesforce/SALESFORCE_UPDATE_OPPORTUNITY",
    effect: "write",
    scope: "composio-salesforce",
    outcome: outcome("ask", "default"),
    minute: 3,
    second: 20,
    answer: "allow_once",
  },
  {
    key: "account-read",
    owner: ANA,
    bot: RESEARCH,
    toolRef: "composio-salesforce/SALESFORCE_GET_ACCOUNT",
    effect: "read",
    scope: "composio-salesforce",
    outcome: outcome("ask", "team_rule", { ruleId: "team-sf-ask" }),
    minute: 4,
    answer: "allow_once",
    withCall: true,
  },
  {
    key: "account-update",
    owner: BEN,
    bot: SALES,
    toolRef: "composio-salesforce/SALESFORCE_UPDATE_ACCOUNT",
    effect: "write",
    scope: "composio-salesforce",
    outcome: outcome("ask", "auto_review", {
      review: {
        verdict: "needs_approval",
        preApproved: false,
        reason: "Changes an account the request did not mention.",
      },
    }),
    minute: 5,
    answer: "deny",
    withCall: true,
  },
  {
    key: "slack-post",
    owner: ANA,
    bot: RESEARCH,
    toolRef: "composio-slack/SLACK_SEND_MESSAGE",
    effect: "write",
    scope: "composio-slack",
    outcome: outcome("ask", "safety"),
    minute: 6,
    answer: "allow_once",
    withCall: true,
  },
  {
    // Allowed by a person's own rule: a verdict and no request.
    key: "label-allowed",
    owner: ANA,
    bot: INBOX,
    toolRef: "composio-gmail/GMAIL_ADD_LABEL_TO_EMAIL",
    effect: "write",
    scope: "composio-gmail",
    outcome: outcome("allow", "personal_rule", { ruleId: "rule-ana-labels" }),
    minute: 7,
    withCall: true,
  },
  {
    key: "label-waiting",
    owner: BEN,
    bot: INBOX,
    toolRef: "composio-gmail/GMAIL_CREATE_LABEL",
    effect: "write",
    scope: "composio-gmail",
    outcome: outcome("ask", "default"),
    minute: 8,
    answer: "pending",
    withCall: true,
  },
  {
    key: "click",
    owner: ANA,
    bot: RESEARCH,
    toolRef: "computer_click",
    effect: "write",
    scope: "www.salesforce.com",
    outcome: outcome("ask", "default"),
    minute: 9,
    answer: "allow_always",
    withCall: true,
    target: {
      pageUrl: "https://www.salesforce.com/form",
      element: { role: "button", name: "Save" },
    },
  },
  {
    // A check-in task asks before every change: its verdict row said one thing, the request another.
    key: "task-label",
    owner: ANA,
    bot: INBOX,
    toolRef: "composio-gmail/GMAIL_ADD_LABEL_TO_EMAIL",
    effect: "write",
    scope: "composio-gmail",
    outcome: outcome("ask", "task"),
    minute: 10,
    answer: "allow_once",
    withCall: true,
  },
  {
    // Its verdict row is older than the slice read: the request is replayed on its own.
    key: "opp-old",
    owner: BEN,
    bot: SALES,
    toolRef: "composio-salesforce/SALESFORCE_UPDATE_OPPORTUNITY",
    effect: "write",
    scope: "composio-salesforce",
    outcome: outcome("ask", "default"),
    minute: 0,
    answer: "deny",
    noVerdict: true,
  },
];

function history(actions: Action[] = WEEK) {
  const evaluated = actions
    .filter((action) => !action.noVerdict)
    .map((action) =>
      action.key === "task-label"
        ? // The gate's own verdict, before the task's ask was laid over it.
          verdict({ ...action, outcome: outcome("allow", "personal_rule") })
        : verdict(action),
    )
    .reverse();
  const requests = actions
    .filter((action) => action.answer)
    .map(request)
    .reverse();
  return { evaluated, requests };
}

const rule = (over: Partial<ApprovalRuleInput>): ApprovalRuleInput => ({
  toolRef: "*",
  effect: "*",
  scope: "*",
  botId: "*",
  behaviour: "ask",
  ...over,
});

describe("one action, counted once", () => {
  test("every verdict is paired with its request, by its call or by who, what and when, and nothing is counted twice", () => {
    const { evaluated, requests } = history();
    const actions = recordedActions(evaluated, requests);
    // 12 actions: 11 verdict rows (one of them for an action that was allowed and asked nobody), and
    // one request whose verdict is not in the slice.
    expect(actions).toHaveLength(12);
    expect(new Set(actions.map((action) => action.id)).size).toBe(12);
    const byId = new Map(actions.map((action) => [action.id, action]));
    // The two identical updates a moment apart each kept their own answer.
    expect(byId.get("audit-opp-2")?.person).toBe("deny");
    expect(byId.get("audit-opp-3")?.person).toBe("allow_once");
    expect(byId.get("audit-opp-1")?.person).toBe("allow_once");
    expect(byId.get("audit-label-allowed")?.person).toBeNull();
    expect(byId.get("audit-label-waiting")?.person).toBe("waiting");
    // The request with no verdict beside it stands for its action, with its own verdict.
    expect(byId.get("request-opp-old")).toMatchObject({
      person: "deny",
      outcome: { behaviour: "ask", source: "default" },
    });
    // A task's ask is what happened, whatever the verdict row said before it was laid over.
    expect(byId.get("audit-task-label")?.outcome.source).toBe("task");
    // The request names what the row does not: the page a click was on.
    expect(byId.get("audit-click")?.subject).toEqual({
      page: "https://www.salesforce.com/form",
    });
  });
});

describe("backtestApprovalRules", () => {
  test("letting the sales Bot update opportunities removes four asks, and says a person had denied two of them", () => {
    const { evaluated, requests } = history();
    const report = backtestApprovalRules(
      [
        rule({
          toolRef: "composio-salesforce/SALESFORCE_UPDATE_OPPORTUNITY",
          effect: "write",
          scope: "composio-salesforce",
          botId: SALES,
          behaviour: "allow",
        }),
      ],
      evaluated,
      requests,
    );
    expect(report).toMatchObject({
      scanned: 12,
      matched: 4,
      changed: 4,
      removedAsks: 4,
      removedDenied: 2,
      addedAsks: 0,
      fixed: 0,
    });
    // The asks a person said no to come first: they are why the list is worth reading.
    expect(report.changes.map((change) => [change.id, change.person])).toEqual([
      ["audit-opp-2", "deny"],
      ["request-opp-old", "deny"],
      ["audit-opp-3", "allow_once"],
      ["audit-opp-1", "allow_once"],
    ]);
    expect(report.changes[0]).toMatchObject({
      was: "ask",
      wasSource: "default",
      would: "allow",
      change: "removes_ask",
      rule: 1,
      bot: SALES,
      ownerUserId: BEN,
    });
  });

  test("asking before any change in Gmail adds one ask, and a safety requirement and a task are fixed", () => {
    const { evaluated, requests } = history();
    const report = backtestApprovalRules(
      [
        rule({
          toolRef: "composio-gmail/*",
          effect: "write",
          scope: "composio-gmail",
          behaviour: "ask",
        }),
      ],
      evaluated,
      requests,
    );
    expect(report).toMatchObject({
      matched: 4,
      changed: 1,
      removedAsks: 0,
      addedAsks: 1,
      // The send a safety requirement asked about, and the task's ask: listed, never counted.
      fixed: 2,
    });
    const changed = report.changes.filter(
      (change) => change.change !== "fixed",
    );
    expect(changed).toEqual([
      expect.objectContaining({
        id: "audit-label-allowed",
        was: "allow",
        wasSource: "personal_rule",
        would: "ask",
        change: "adds_ask",
      }),
    ]);
    expect(
      report.changes
        .filter((change) => change.change === "fixed")
        .map((change) => [change.id, change.was, change.would, change.reason]),
    ).toEqual([
      [
        "audit-task-label",
        "ask",
        "ask",
        "A task started from a check-in asks before every change.",
      ],
      [
        "audit-send-1",
        "ask",
        "ask",
        "A safety requirement decided this. Rules don't change that.",
      ],
    ]);
  });

  test("auto-review and safety outcomes stay as they were whatever the rule does", () => {
    const { evaluated, requests } = history();
    const report = backtestApprovalRules(
      [rule({ toolRef: "*", effect: "*", scope: "*", behaviour: "allow" })],
      evaluated,
      requests,
    );
    // Allowing everything would remove every ask a default raised, and none of the three a safety
    // requirement or auto-review raised, though a person had denied two of those, nor the task's.
    const fixedIds = report.changes
      .filter((change) => change.change === "fixed")
      .map((change) => change.id)
      .sort();
    expect(fixedIds).toEqual([
      "audit-account-update",
      "audit-send-1",
      "audit-slack-post",
      "audit-task-label",
    ]);
    expect(report.fixed).toBe(4);
    for (const change of report.changes.filter((c) => c.change === "fixed"))
      expect(change.would).toBe(change.was);
    // The team rule that asks about Salesforce reads is not loosened by a looser team rule.
    expect(report.changes.map((change) => change.id)).not.toContain(
      "audit-account-read",
    );
    expect(report).toMatchObject({
      scanned: 12,
      matched: 12,
      removedAsks: 6,
      removedDenied: 2,
      addedAsks: 0,
      changed: 6,
    });
  });

  test("a rule that is not stricter than the rule that decided changes nothing", () => {
    const { evaluated, requests } = history();
    const report = backtestApprovalRules(
      [
        rule({
          toolRef: "composio-salesforce/*",
          effect: "read",
          scope: "composio-salesforce",
          behaviour: "allow",
        }),
      ],
      evaluated,
      requests,
    );
    expect(report).toMatchObject({
      matched: 1,
      changed: 0,
      fixed: 0,
      changes: [],
    });
  });

  test("hand-off for the inbox Bot's labels is stricter than asking, and adds an ask where it allowed", () => {
    const { evaluated, requests } = history();
    const report = backtestApprovalRules(
      [
        rule({
          toolRef: "composio-gmail/GMAIL_*_LABEL*",
          effect: "write",
          scope: "composio-gmail",
          botId: INBOX,
          behaviour: "hand_off",
        }),
      ],
      evaluated,
      requests,
    );
    expect(
      report.changes.map((change) => [change.id, change.change, change.would]),
    ).toEqual([
      ["audit-label-waiting", "stricter", "hand_off"],
      ["audit-label-allowed", "adds_ask", "hand_off"],
      ["audit-task-label", "fixed", "ask"],
    ]);
    expect(report).toMatchObject({ changed: 2, addedAsks: 1, fixed: 1 });
  });

  test("no history, or rules about nothing on it, is an empty answer rather than an error", () => {
    expect(
      backtestApprovalRules([rule({ toolRef: "composio-slack/*" })], [], []),
    ).toEqual({
      scanned: 0,
      matched: 0,
      changed: 0,
      removedAsks: 0,
      removedDenied: 0,
      addedAsks: 0,
      fixed: 0,
      changes: [],
    });
  });
});
