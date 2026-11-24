/**
 * The phone's Questions and approvals screen says what a Bot wants to do in the words the web card
 * uses, shows a settings change's before, after and who it reaches, and never offers "Always allow"
 * on a change the organization set to ask every time.
 *
 * FOUND IN THE PHONE APP (iOS simulator, local stack): an admin's organization change read
 * "general-assistant asks to use openbot-settings/update_organization_settings" over
 * `{"settings": {"proactiveDailyRuns": 22}}`, with "Always allow this scope", which the server
 * refuses for it. The approval below is that one, as the API sent it.
 *
 * The phone's copies are held to the web's originals (shared/tool-name.ts, shared/standing-rule.ts).
 */
import { expect, test } from "bun:test";
import { offersStandingRule as webOffersStandingRule } from "../../shared/standing-rule";
import {
  approvalDetails as webApprovalDetails,
  approvalPhrase as webApprovalPhrase,
} from "../../shared/tool-name";
import {
  type ApprovalActionWords,
  approvalAsk,
  approvalChange,
  approvalChoices,
  approvalDetails,
  approvalTitle,
  offersStandingRule,
} from "../src/approval-words";

/** The organization change the phone showed, as listApprovals sent it. */
const organizationChange: ApprovalActionWords = {
  botId: "general-assistant",
  toolRef: "openbot-settings/update_organization_settings",
  scope: "openbot-settings",
  args: { settings: { proactiveDailyRuns: 22 } },
  target: {
    url: "builtin://openbot-settings",
    change: {
      after: { proactiveDailyRuns: 22 },
      before: { proactiveDailyRuns: 81 },
      changes: [
        {
          after: "Up to 22 check-ins a day per Bot for each person",
          label: "Daily limit",
          before: "Up to 81 check-ins a day per Bot for each person",
        },
      ],
      summary: "Daily limit: Up to 22 check-ins a day per Bot for each person",
      affected: {
        count: 2,
        people: [
          { name: "Priya Raman", email: "priya@northwind.test" },
          { name: "Marcus Bell", email: "marcus@northwind.test" },
        ],
        summary: "Everyone in OpenBot (2 people)",
      },
    },
    effect: "write",
    serverId: "openbot-settings",
    toolName: "update_organization_settings",
  },
  policy: {
    behaviour: "ask",
    source: "safety",
    reason: "Changes to your organization ask you every time.",
    closed: true,
  },
};

test("an organization change reads as the web card says it, with the Bot by name", () => {
  expect(approvalTitle(organizationChange, "General Assistant")).toBe(
    "General Assistant wants to change your organization's settings",
  );
  // Never the ids the screen used to show.
  expect(approvalTitle(organizationChange, "General Assistant")).not.toContain(
    "openbot-settings",
  );
  expect(approvalTitle(organizationChange, undefined)).toBe(
    "Your Bot wants to change your organization's settings",
  );
});

test("its change shows before and after in the screens' words, and who it reaches", () => {
  expect(approvalChange(organizationChange.target)).toEqual({
    summary: "Daily limit: Up to 22 check-ins a day per Bot for each person",
    rows: [
      {
        label: "Daily limit",
        before: "Up to 81 check-ins a day per Bot for each person",
        after: "Up to 22 check-ins a day per Bot for each person",
      },
    ],
    affected: {
      summary: "Everyone in OpenBot (2 people)",
      people: ["Priya Raman", "Marcus Bell"],
      more: 0,
    },
  });
});

test("a change the organization set to ask every time offers only Allow once and Deny", () => {
  expect(approvalChoices(organizationChange)).toEqual(["allow_once", "deny"]);
  const open = {
    ...organizationChange,
    policy: { source: "default", behaviour: "ask" },
  };
  expect(approvalChoices(open)).toEqual(["allow_once", "allow_always", "deny"]);
});

test("a change with no rows lists the values that differ", () => {
  expect(
    approvalChange({
      change: {
        summary: "Narration on",
        before: { narration: false, skin: "classic" },
        after: { narration: true, skin: "classic" },
      },
    }),
  ).toEqual({
    summary: "Narration on",
    rows: [{ label: "Narration", before: "Off", after: "On" }],
  });
  expect(approvalChange({ url: "https://example.test" })).toBeNull();
  expect(approvalChange(undefined)).toBeNull();
});

test("every settings tool reads exactly as the web names it", () => {
  const settings = (tool: string, args?: unknown, target?: unknown) => ({
    botId: "scout",
    toolRef: `openbot-settings/${tool}`,
    scope: "openbot-settings",
    args,
    target,
  });
  const cases = [
    settings("update_my_settings"),
    settings("update_my_bot", {}, { change: { bot: { name: "Scout" } } }),
    settings("update_my_bot"),
    settings("update_organization_settings"),
    settings("manage_people", { action: "invite" }),
    settings("manage_people", { action: "change_role" }),
    settings("manage_people", { action: "remove" }),
    settings("manage_people"),
    settings("manage_teams", { action: "create" }),
    settings("manage_teams", { action: "rename" }),
    settings("manage_teams", { action: "move" }),
    settings("manage_teams", { action: "add_member" }),
    settings("manage_teams", { action: "remove_member" }),
    settings("manage_teams"),
  ];
  for (const action of cases)
    expect(approvalAsk(action)).toBe(webApprovalPhrase(action));
});

test("the standing-answer rule is the web's", () => {
  const policies = [
    undefined,
    { source: "default", behaviour: "ask" },
    { source: "task", behaviour: "ask" },
    { source: "safety", behaviour: "ask", closed: true },
    { source: "team_rule", behaviour: "hand_off" },
  ];
  for (const policy of policies) {
    const action = { ...organizationChange, policy };
    expect(offersStandingRule(action)).toBe(webOffersStandingRule(action));
  }
});

test("another action's arguments read as labelled lines, as on the web", () => {
  const args = [
    { to: "sam@example.test", subject: "Hello", urgent: true, count: 3 },
    { ref: "f3e43", snapshotId: 4 },
    { recipientIds: ["a", "b"], url: "https://example.test", nested: { a: 1 } },
    null,
    ["not", "an", "object"],
  ];
  for (const each of args)
    expect(approvalDetails(each)).toEqual(webApprovalDetails(each));
});
