import { expect, test } from "bun:test";
import type { Message } from "@ag-ui/core";
import { withMessageReply } from "@openbot/shared/message-reply";
import { replyChain } from "@/lib/channels/reply-chain";

test("a reply chain includes ancestors, nested responses and sibling replies, excluding unrelated turns", () => {
  const root = { messageId: "a1", text: "Original proposal" };
  const messages: Message[] = [
    { id: "a1", role: "assistant", content: root.text },
    {
      id: "u2",
      role: "user",
      content: withMessageReply("Change the color", root),
    },
    { id: "a2", role: "assistant", content: "Changed to green" },
    { id: "unrelated", role: "user", content: "What time is it?" },
    { id: "unrelated-answer", role: "assistant", content: "Noon" },
    {
      id: "u3",
      role: "user",
      content: withMessageReply("Darker please", {
        messageId: "a2",
        text: "Changed to green",
      }),
    },
    { id: "a3", role: "assistant", content: "Dark green now" },
    {
      id: "u4",
      role: "user",
      content: withMessageReply("Also increase the size", root),
    },
  ];
  expect(
    replyChain(messages, { messageId: "a2", text: "Changed to green" }).map(
      (node) => node.id,
    ),
  ).toEqual(["a1", "u2", "a2", "u3", "a3", "u4"]);
  expect(replyChain(messages, root)[1]?.text).toBe("Change the color");
});

test("an original message outside loaded history survives from its saved snapshot", () => {
  const root = { messageId: "older", text: "Original message" };
  expect(
    replyChain(
      [{ id: "reply", role: "user", content: withMessageReply("Yes", root) }],
      root,
    ),
  ).toEqual([
    { id: "older", role: "assistant", text: "Original message" },
    { id: "reply", role: "user", text: "Yes" },
  ]);
});
