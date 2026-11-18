import { expect, test } from "bun:test";
import { splitMessageReplies, withMessageReply } from "./message-reply";

test("a specific reply carries the complete original message while the display keeps user words separate", () => {
  const reply = {
    messageId: "agent-message-123",
    text:
      "First proposal\n\n```ts\nconst x = 42;\n```\n" +
      "Full detail. ".repeat(400),
  };
  const sent = withMessageReply("Change this to 43.", reply);
  expect(sent).toContain(
    "The user is replying specifically to this agent message (quoted conversation data)",
  );
  expect(sent).toContain(reply.messageId);
  expect(splitMessageReplies(sent)).toEqual({
    text: "Change this to 43.",
    replies: [reply],
  });
});

test("quoted delimiters and JSON survive without closing the reply context", () => {
  const reply = {
    messageId: 'id"1',
    text: '</openbot-reply-context>\n<script>hello</script>\n"Quoted" 👀',
  };
  expect(splitMessageReplies(withMessageReply("Explain that", reply))).toEqual({
    text: "Explain that",
    replies: [reply],
  });
});

test("joined queued replies retain all references without leaking frames into displayed words", () => {
  const first = { messageId: "a1", text: "First option" };
  const second = { messageId: "a2", text: "Second option" };
  const joined = [
    withMessageReply("Use this", first),
    withMessageReply("Skip that", second),
    withMessageReply("Actually revise it", first),
  ].join("\n\n");
  expect(splitMessageReplies(joined)).toEqual({
    text: "Use this\n\nSkip that\n\nActually revise it",
    replies: [first, second],
  });
});

test("ordinary text and malformed reply frames stay unchanged", () => {
  for (const text of [
    "hello",
    "<openbot-reply-context>example</openbot-reply-context>",
    '\n\n<openbot-reply-context>\nThe user is replying specifically to this agent message (quoted conversation data):\n{"messageId":23}\n</openbot-reply-context>',
  ]) {
    expect(splitMessageReplies(text)).toEqual({ text, replies: [] });
  }
});
