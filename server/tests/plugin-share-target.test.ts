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

describe("a Composio Gmail send is addressed to the person it goes to", () => {
  /*
   * Composio's GMAIL_SEND_EMAIL and GMAIL_REPLY_TO_THREAD name the primary recipient
   * `recipient_email` and further To addresses `extra_recipients` (see
   * fixtures/composio-file-actions.json). The audience id is what an "always allow" rule is scoped
   * to, so a send whose recipient was not read collapsed onto `<server>/<tool>`, and allowing one
   * email allowed every later one, to anybody.
   */
  test("the primary and extra recipients are the audience", () => {
    const send = shareTargetOf("composio-gmail", "GMAIL_SEND_EMAIL", {
      recipient_email: "alice@example.com",
      extra_recipients: ["bob@example.com"],
      subject: "Q3",
      body: "The Q3 numbers are in",
    });
    expect(send?.audience.id).toBe("alice@example.com bob@example.com");
    expect(send?.audience.label).toBe(
      "composio-gmail: alice@example.com bob@example.com",
    );
  });

  test("two replies to different people are two audiences", () => {
    const reply = (recipient: string) =>
      shareTargetOf("composio-gmail", "GMAIL_REPLY_TO_THREAD", {
        thread_id: "t-1",
        recipient_email: recipient,
        message_body: "Sounds good",
      })?.audience.id;
    expect(reply("alice@example.com")).toBe("alice@example.com");
    expect(reply("mallory@example.com")).toBe("mallory@example.com");
  });
});
