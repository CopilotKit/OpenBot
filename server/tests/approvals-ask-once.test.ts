import { describe, expect, test } from "bun:test";
import {
  ASKING_GUIDANCE,
  BROUGHT_BOT_ASKING_GUIDANCE,
  DESTRUCTIVE_TOOL_NOTE,
} from "@openbot/shared/bot-prompt";
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
    expect(prompt).toContain(ASKING_GUIDANCE);
    expect(ASKING_GUIDANCE).toContain("do not ask them first");
  });

  test("a remote Bot is told so only for what OpenBot gives it: its own tools don't go through OpenBot's gate", () => {
    const role = standingRoleMessage({
      id: "risk",
      name: "Risk",
      title: "Risk desk",
      roleDescription: "Investigate policies.",
    });
    expect(role.content).not.toContain(ASKING_GUIDANCE);
    expect(role.content).toContain(BROUGHT_BOT_ASKING_GUIDANCE);
    const said = BROUGHT_BOT_ASKING_GUIDANCE.replace(/\s+/g, " ");
    expect(said).toContain(
      "When you use the apps and tools OpenBot gives you, OpenBot asks the person itself before you delete",
    );
    // Its own tools are not covered, so it still asks before one of them does something final.
    expect(said).toContain(
      "Tools of your own that OpenBot did not give you are not covered: ask before one of those does something that cannot be undone.",
    );
  });

  // Each action the guidance names, as a button a Bot presses: the policy must ask about every one.
  test.each([
    ["delete", "Delete", "ask"],
    ["send", "Send", "ask"],
    ["share", "Share", "ask"],
    ["post", "Post", "ask"],
    ["pay for", "Pay", "ask"],
    ["buy", "Buy now", "ask"],
  ] as const)(
    "the guidance says OpenBot asks before you %s, and it does",
    (said, button, behaviour) => {
      expect(ASKING_GUIDANCE.replace(/\s+/g, " ")).toContain(said);
      expect(safetyRequirement(click(button))?.behaviour).toBe(behaviour);
    },
  );

  // An app tool, as the plugin store puts it to the gate.
  const app = (name: string, destructive?: true): ApprovalCandidate => ({
    actorId: "owner",
    botId: "assistant",
    toolRef: `acme-crm/${name}`,
    effect: "write",
    scope: "acme-crm",
    args: { id: "51" },
    ...(destructive ? { destructive } : {}),
  });

  test("the guidance promises a card for deleting in the person's apps, never on the Bot's own computer", () => {
    const guidance = ASKING_GUIDANCE.replace(/\s+/g, " ");
    expect(guidance).toContain(
      "before you delete, archive, send, share or post anything in their apps or on websites",
    );
    expect(guidance).toContain("Your own computer is your scratch space");
    // As the policy has it: deleting a file in the Bot's own workspace is an ordinary change.
    expect(
      safetyRequirement({
        actorId: "owner",
        botId: "assistant",
        toolRef: "computer_run_command",
        effect: "write",
        scope: "workspace",
        args: { command: "rm -f decline-test-f6.txt && echo deleted" },
      }),
    ).toBeUndefined();
    expect(safetyRequirement(app("GOOGLEDRIVE_DELETE_FILE"))?.behaviour).toBe(
      "ask",
    );
  });

  test("the guidance says OpenBot asks before you archive, and it does", () => {
    expect(ASKING_GUIDANCE.replace(/\s+/g, " ")).toContain(
      "delete, archive, send",
    );
    expect(safetyRequirement(app("HUBSPOT_ARCHIVE_CONTACT"))?.behaviour).toBe(
      "ask",
    );
  });

  test("a tool its app marks destructive says so on itself, in the words the guidance names, and OpenBot asks", () => {
    const guidance = ASKING_GUIDANCE.replace(/\s+/g, " ");
    expect(guidance).toContain(
      "before you use a tool that says it deletes or overwrites something",
    );
    expect(DESTRUCTIVE_TOOL_NOTE).toContain("deletes or overwrites something");
    expect(DESTRUCTIVE_TOOL_NOTE).toContain("Don't ask them first.");
    // Named like nothing, so only the mark can tell the Bot.
    expect(safetyRequirement(app("reset_pipeline"))).toBeUndefined();
    expect(safetyRequirement(app("reset_pipeline", true))?.behaviour).toBe(
      "ask",
    );
  });
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
