import { describe, expect, test } from "bun:test";
import { shareTargetOf } from "../src/plugins/share-target";

describe("which connector writes send content to other people", () => {
  test("a message, a post, a reply and an email are sends, addressed to their recipients", () => {
    const slack = shareTargetOf("slack", "slack_send_message", {
      channel: "C123",
      text: "The Q3 numbers are in",
    });
    expect(slack).toEqual({
      audience: expect.objectContaining({
        kind: "external",
        id: "C123",
        recipientUserIds: [],
      }),
      content: "The Q3 numbers are in",
    });
    expect(
      shareTargetOf("gmail", "GMAIL_SEND_EMAIL", { to: "x@y.test", body: "hi" })
        ?.audience.id,
    ).toBe("x@y.test");
    expect(
      shareTargetOf("teams", "postMessage", {
        chatId: "19:abc",
        content: "hi",
      }),
    ).not.toBeNull();
    expect(
      shareTargetOf("linear", "create_comment", { issueId: "L-1", body: "hi" }),
    ).not.toBeNull();
  });

  test("a write that stages or changes the owner's own data is not", () => {
    expect(
      shareTargetOf("gmail", "create_draft", { to: "x@y.test", body: "hi" }),
    ).toBeNull();
    expect(shareTargetOf("notion", "update_page", { text: "hi" })).toBeNull();
    expect(shareTargetOf("linear", "create_issue", { title: "hi" })).toBeNull();
  });
});
