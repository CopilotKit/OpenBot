import { describe, expect, test } from "bun:test";
import { ruleMatches } from "../../server/src/approvals/policy";
import type { ApprovalCandidate } from "../../server/src/approvals/types";
import { TOOL_PATTERN_EXAMPLE } from "../src/components/approvals/rules";

/**
 * The example the team rule form shows is what admins copy. It used to be `mcp/gmail/*`, and no
 * real tool name starts with `mcp/`, so a rule typed from the hint matched nothing and silently
 * never applied. The example is checked against the gate's own matcher and real tool names.
 */
describe("the team rule form's tool example", () => {
  const rule = (toolRef: string) => ({
    id: "example",
    botId: "*",
    toolRef,
    effect: "*",
    scope: "*",
    behaviour: "ask" as const,
  });
  const call = (toolRef: string): ApprovalCandidate => ({
    actorId: "person-1",
    botId: "bot-1",
    toolRef,
    effect: "write",
    scope: "composio-gmail",
    args: {},
  });

  test("matches every Gmail tool, as the hint says", () => {
    for (const tool of [
      "composio-gmail/GMAIL_SEND_EMAIL",
      "composio-gmail/GMAIL_CREATE_EMAIL_DRAFT",
      "composio-gmail/GMAIL_ADD_LABEL_TO_EMAIL",
    ])
      expect(
        ruleMatches(rule(TOOL_PATTERN_EXAMPLE), call(tool), "team_rule"),
      ).toBe(true);
  });

  test("matches no other app's tools", () => {
    expect(
      ruleMatches(
        rule(TOOL_PATTERN_EXAMPLE),
        call("composio-salesforce/SALESFORCE_UPDATE_OPPORTUNITY"),
        "team_rule",
      ),
    ).toBe(false);
  });
});
