import { describe, expect, test } from "bun:test";
import {
  channelUserId,
  linkCodeIn,
  runInput,
  textFromAgUiStream,
} from "./opentag";

describe("OpenTag-shaped Telegram helpers", () => {
  test("names the sender as telegram:bot:chat", () => {
    expect(channelUserId({ botId: "99", chatId: "42" })).toBe("telegram:99:42");
  });

  test("finds a Reachability link code in a message", () => {
    expect(
      linkCodeIn("please link 6f2b9d4e-1a3c-4e5f-8b7a-0c9d2e1f3a4b thanks"),
    ).toBe("6f2b9d4e-1a3c-4e5f-8b7a-0c9d2e1f3a4b");
    expect(linkCodeIn("hello")).toBeNull();
  });

  test("builds a run that carries the OpenBot sender context", () => {
    const input = runInput({
      botId: "99",
      chatId: "42",
      messageId: "7",
      text: "link 6f2b9d4e-1a3c-4e5f-8b7a-0c9d2e1f3a4b",
      privateChat: true,
    });
    expect(input.threadId).toBe("telegram:99:42");
    expect(input.messages[0]?.content).toContain("link ");
    const sender = JSON.parse(input.context[0]?.value ?? "{}") as {
      user: string;
      conversation: { kind: string };
    };
    expect(sender.user).toBe("telegram:99:42");
    expect(sender.conversation.kind).toBe("direct");
  });

  test("reads text deltas from an AG-UI stream", () => {
    const body = [
      'data: {"type":"TEXT_MESSAGE_CONTENT","delta":"Hello "}',
      'data: {"type":"TEXT_MESSAGE_CONTENT","delta":"there"}',
      "data: [DONE]",
      "",
    ].join("\n");
    expect(textFromAgUiStream(body)).toBe("Hello there");
  });
});
