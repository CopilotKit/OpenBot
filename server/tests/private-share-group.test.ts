import { expect, test } from "bun:test";
import type { ApprovalRecord } from "../src/approvals/types";
import { createPrivateShareCheck } from "../src/proactive/private-share";

const continuation = {
  runId: "run",
  threadId: "thread",
  toolCallId: "call",
  toolName: "post_to_group",
  args: {},
  messages: [],
  state: {},
  context: [],
  forwardedProps: {},
};

/**
 * An "always allow" for a group was given for the people in it then. Anyone in a group can add more
 * people, so a later member must not inherit the owner's permission: the owner is asked again.
 */
test("an always-allow for a group does not cover people added to it later", async () => {
  const opened: { scope: string }[] = [];
  const rules: unknown[] = [];
  const check = createPrivateShareCheck({
    approvals: {
      rules: async () => rules as never,
      list: async () => [],
      open: async (action: never) => {
        opened.push(action);
        return {
          id: `approval-${opened.length}`,
          status: "pending",
        } as ApprovalRecord;
      },
    },
  });
  const share = (recipientUserIds: string[]) =>
    check({
      ownerUserId: "owner",
      botId: "bot",
      audience: { kind: "group", id: "group-1", recipientUserIds },
      content: "From your notes: the launch slipped.",
      origin: { kind: "private_conversation" },
      continuation,
    });

  expect((await share(["owner", "priya"])).status).toBe("pending");
  // The owner answers "always allow": the ledger keeps a rule for the scope that was asked about.
  rules.push({
    botId: "bot",
    toolRef: "openbot/share_private_information",
    effect: "share_private",
    scope: opened[0]?.scope,
    revokedAt: null,
  });
  expect((await share(["owner", "priya"])).status).toBe("allowed");

  // Priya adds Sam. The rule was for the owner and Priya, so the owner is asked again.
  expect((await share(["owner", "priya", "sam"])).status).toBe("pending");
  expect(opened).toHaveLength(2);
});
