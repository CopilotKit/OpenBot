import { describe, expect, test } from "bun:test";
import type { Message } from "@ag-ui/core";
import { toVisibleChatItems } from "../src/components/channels/chat-messages";

describe("toVisibleChatItems", () => {
  test("projects a user message with plain string content", () => {
    const messages: Message[] = [
      { id: "msg-1", role: "user", content: "Hello there" },
    ];

    expect(toVisibleChatItems(messages)).toEqual([
      { kind: "text", id: "msg-1", role: "user", text: "Hello there" },
    ]);
  });

  test("projects a user message with array content parts", () => {
    const messages: Message[] = [
      {
        id: "msg-2",
        role: "user",
        content: [
          { type: "text", text: "First line" },
          { type: "text", text: "Second line" },
        ],
      },
    ];

    expect(toVisibleChatItems(messages)).toEqual([
      {
        kind: "text",
        id: "msg-2",
        role: "user",
        text: "First line\nSecond line",
      },
    ]);
  });

  test("filters out non-text parts from user message array content", () => {
    const messages: Message[] = [
      {
        id: "msg-3",
        role: "user",
        content: [
          { type: "text", text: "Visible text" },
          { type: "binary", mimeType: "image/png", data: "..." } as never,
        ],
      },
    ];

    expect(toVisibleChatItems(messages)).toEqual([
      { kind: "text", id: "msg-3", role: "user", text: "Visible text" },
    ]);
  });

  test("handles undefined, null, or empty content gracefully without throwing", () => {
    const messages: Message[] = [
      { id: "msg-4", role: "user", content: undefined as never },
      { id: "msg-5", role: "user", content: null as never },
      { id: "msg-6", role: "user", content: "" },
      { id: "msg-7", role: "user", content: [] },
    ];

    expect(toVisibleChatItems(messages)).toEqual([]);
  });

  test("handles arrays containing null, undefined, or primitive items safely", () => {
    const messages: Message[] = [
      {
        id: "msg-8",
        role: "user",
        content: [
          null,
          undefined,
          "raw string item",
          123,
          { type: "text", text: "Valid text" },
          { type: "text" },
          { type: "text", text: "" },
        ] as never,
      },
    ];

    expect(toVisibleChatItems(messages)).toEqual([
      { kind: "text", id: "msg-8", role: "user", text: "Valid text" },
    ]);
  });

  test("projects assistant messages and pairs tool calls with results", () => {
    const messages: Message[] = [
      {
        id: "msg-8",
        role: "assistant",
        content: "Let me check that for you.",
        toolCalls: [
          {
            id: "call-1",
            type: "function",
            function: { name: "computer_read", arguments: "{}" },
          },
        ],
      },
      {
        id: "msg-9",
        role: "tool",
        toolCallId: "call-1",
        content: "Page title: Example",
      } as Message,
    ];

    expect(toVisibleChatItems(messages)).toEqual([
      {
        kind: "text",
        id: "msg-8",
        role: "assistant",
        text: "Let me check that for you.",
      },
      {
        kind: "tool",
        id: "call-1",
        toolCall: {
          id: "call-1",
          type: "function",
          function: { name: "computer_read", arguments: "{}" },
        },
        result: "Page title: Example",
      },
    ]);
  });

  test("ignores non-user and non-assistant messages", () => {
    const messages: Message[] = [
      { id: "msg-10", role: "system", content: "System prompt" } as Message,
    ];

    expect(toVisibleChatItems(messages)).toEqual([]);
  });
});
