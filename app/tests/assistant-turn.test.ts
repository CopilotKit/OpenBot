import { expect, test } from "bun:test";
import type { Message } from "@ag-ui/core";
import { assistantTurn } from "@/lib/channels/assistant-turn";

test("a text message followed by a tool-only message owns one toolbar after the tool card", () => {
  const messages: Message[] = [
    { id: "ask", role: "user", content: "Find today's news" },
    { id: "intro", role: "assistant", content: "I'll find today's news." },
    {
      id: "handoff",
      role: "assistant",
      toolCalls: [
        {
          id: "task",
          type: "function",
          function: { name: "delegate", arguments: "{}" },
        },
      ],
    },
    {
      id: "tool-result",
      role: "tool",
      toolCallId: "task",
      content: '{"taskId":"private-task-id"}',
    },
    { id: "next-ask", role: "user", content: "Thanks" },
    { id: "next-answer", role: "assistant", content: "You're welcome." },
  ];
  for (const id of ["intro", "handoff"]) {
    expect(assistantTurn(messages, id)).toEqual({
      messageId: "handoff",
      text: "I'll find today's news.",
      settled: true,
    });
  }
  expect(assistantTurn(messages, "next-answer")).toEqual({
    messageId: "next-answer",
    text: "You're welcome.",
    settled: false,
  });
});
