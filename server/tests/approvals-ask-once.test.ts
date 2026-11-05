import { describe, expect, test } from "bun:test";
import { APPROVAL_GUIDANCE } from "@openbot/shared/bot-prompt";
import { safetyRequirement } from "../src/approvals/policy";
import type { ApprovalCandidate } from "../src/approvals/types";
import { builtInAgentConfiguration, standingRoleMessage } from "../src/copilot";

/**
 * One ask for one consequential action.
 *
 * The person was asked twice for one delete: once by the Bot, on its own approval card, and again by
 * OpenBot's safety policy, which asks whatever came before. The policy's card names the exact action,
 * so it is the one that stays, and a Bot OpenBot runs is told not to ask first. That is safe only for
 * as long as the policy really asks about every action the Bot is told it asks about, which is what
 * the second half pins.
 */

const click = (name: string): ApprovalCandidate => ({
  actorId: "owner",
  botId: "assistant",
  toolRef: "computer_click",
  effect: "write",
  scope: "app.example",
  args: { ref: "e12" },
  target: {
    pageUrl: "https://app.example/inbox",
    element: { ref: "e12", role: "button", name },
  },
});

const prompt = (() => {
  const configuration = builtInAgentConfiguration(
    {
      id: "personal-assistant",
      name: "Personal Assistant",
      type: "built_in",
      systemPrompt: "Help with everyday errands.",
    },
    { provider: "openai", defaultModel: "gpt-5.6-terra" },
    "openai-secret",
  );
  return "prompt" in configuration ? (configuration.prompt ?? "") : "";
})();

describe("a Bot OpenBot runs leaves the asking to OpenBot", () => {
  test("it is told OpenBot asks before consequential actions, and not to ask first", () => {
    expect(prompt).toContain(APPROVAL_GUIDANCE);
    expect(APPROVAL_GUIDANCE).toContain("do not ask them first");
  });

  test("a remote Bot is not told so: its own tools don't go through OpenBot's gate", () => {
    const role = standingRoleMessage({
      id: "risk",
      name: "Risk",
      title: "Risk desk",
      roleDescription: "Investigate policies.",
    });
    expect(role.content).not.toContain(APPROVAL_GUIDANCE);
  });

  // Each action the guidance names, as a button a Bot presses: the policy must ask about every one.
  test.each([
    ["delete", "Delete", "ask"],
    ["send", "Send", "ask"],
    ["share", "Share", "ask"],
    ["post", "Post", "ask"],
    ["pay for", "Pay", "hand_off"],
    ["buy", "Buy now", "hand_off"],
  ] as const)(
    "the guidance says OpenBot asks before you %s, and it does",
    (said, button, behaviour) => {
      expect(APPROVAL_GUIDANCE.replace(/\s+/g, " ")).toContain(said);
      expect(safetyRequirement(click(button))?.behaviour).toBe(behaviour);
    },
  );
});

describe("a send by keyboard asks, as a Send button does", () => {
  const press = (key: string, field = "Message body"): ApprovalCandidate => ({
    actorId: "owner",
    botId: "assistant",
    toolRef: "computer_key",
    effect: "write",
    scope: "mail.google.com",
    args: { key, ref: "f3" },
    target: {
      pageUrl: "https://mail.google.com/mail/u/0/#inbox?compose=new",
      element: { ref: "f3", role: "textbox", name: field },
    },
  });
  const submit = (field: string): ApprovalCandidate => ({
    actorId: "owner",
    botId: "assistant",
    toolRef: "computer_type",
    effect: "write",
    scope: "app.slack.com",
    args: { ref: "f9", text: "Friday works.", submit: true },
    target: {
      pageUrl: "https://app.slack.com/client/T1/C1",
      element: { ref: "f9", role: "textbox", name: field },
    },
  });

  test.each([
    "Meta+Enter",
    "Control+Enter",
    "ControlOrMeta+Enter",
    "Ctrl+Enter",
  ])("%s sends", (key) => {
    expect(safetyRequirement(press(key))).toMatchObject({
      id: "sending",
      behaviour: "ask",
    });
  });

  test("Enter in a box for writing a message sends", () => {
    expect(safetyRequirement(press("Enter", "Message #general"))?.id).toBe(
      "sending",
    );
    expect(safetyRequirement(submit("Message #general"))?.id).toBe("sending");
    expect(safetyRequirement(submit("Reply…"))?.id).toBe("sending");
  });

  test("Enter in a search box, a plain field or a letter does not", () => {
    expect(safetyRequirement(submit("Search messages"))).toBeUndefined();
    expect(safetyRequirement(submit("Subject"))).toBeUndefined();
    expect(safetyRequirement(press("Enter", "Subject"))).toBeUndefined();
    expect(safetyRequirement(press("Shift+Enter"))).toBeUndefined();
    expect(safetyRequirement(press("a"))).toBeUndefined();
    expect(safetyRequirement(press("Control+a"))).toBeUndefined();
  });
});
