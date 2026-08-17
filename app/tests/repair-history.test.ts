import { describe, expect, test } from "bun:test";
import type { Message } from "@ag-ui/core";
import { repairUnansweredToolCalls } from "../src/lib/copilot/repair-history";

/**
 * A stored thread must remain provider-valid even when a tool call lost its result.
 */

const call = (id: string, name = "showBarChart") => ({
  id,
  type: "function" as const,
  function: { name, arguments: "{}" },
});

let counter = 0;
const ids = () => `fixed_${++counter}`;

describe("repairing a history before it is sent", () => {
  test("a tool call with no result is answered", () => {
    const messages = [
      { id: "u1", role: "user", content: "chart it" },
      { id: "a1", role: "assistant", content: "", toolCalls: [call("c1")] },
    ] as Message[];

    const repaired = repairUnansweredToolCalls(messages, ids);

    expect(repaired).toHaveLength(3);
    const result = repaired[2] as {
      role: string;
      toolCallId: string;
      content: string;
    };
    expect(result.role).toBe("tool");
    expect(result.toolCallId).toBe("c1");
    // Insert an explanatory result, not an empty one.
    expect(result.content.length).toBeGreaterThan(0);
    expect(result.content).toContain("no result");
  });

  test("a result is placed immediately after the call that asked for it", () => {
    const messages = [
      { id: "a1", role: "assistant", content: "", toolCalls: [call("c1")] },
      { id: "u1", role: "user", content: "and again" },
    ] as Message[];

    const repaired = repairUnansweredToolCalls(messages, ids);

    // Providers require the result immediately after the call it answers.
    expect(repaired.map((message) => message.role)).toEqual([
      "assistant",
      "tool",
      "user",
    ]);
  });

  test("a history that is already complete is returned untouched", () => {
    const messages = [
      { id: "a1", role: "assistant", content: "", toolCalls: [call("c1")] },
      { id: "t1", role: "tool", toolCallId: "c1", content: "done" },
    ] as Message[];

    // Healthy histories keep identity to avoid churn on every send.
    expect(repairUnansweredToolCalls(messages, ids)).toBe(messages);
  });

  test("only the unanswered call in a batch is repaired", () => {
    const messages = [
      {
        id: "a1",
        role: "assistant",
        content: "",
        toolCalls: [call("c1"), call("c2"), call("c3")],
      },
      { id: "t2", role: "tool", toolCallId: "c2", content: "real result" },
    ] as Message[];

    const repaired = repairUnansweredToolCalls(messages, ids);
    const results = repaired.filter((message) => message.role === "tool") as {
      toolCallId: string;
      content: string;
    }[];

    expect(results.map((result) => result.toolCallId).sort()).toEqual([
      "c1",
      "c2",
      "c3",
    ]);
    // The real one is left exactly as it was.
    expect(results.find((r) => r.toolCallId === "c2")?.content).toBe(
      "real result",
    );
  });

  test("an empty-string result already counts as answered", () => {
    const messages = [
      { id: "a1", role: "assistant", content: "", toolCalls: [call("c1")] },
      { id: "t1", role: "tool", toolCallId: "c1", content: "" },
    ] as Message[];

    // Empty string is a valid protocol result.
    expect(repairUnansweredToolCalls(messages, ids)).toBe(messages);
  });

  test("the same call id across two messages is answered once", () => {
    const messages = [
      { id: "a1", role: "assistant", content: "", toolCalls: [call("c1")] },
      { id: "a2", role: "assistant", content: "", toolCalls: [call("c1")] },
    ] as Message[];

    const repaired = repairUnansweredToolCalls(messages, ids);
    const results = repaired.filter((message) => message.role === "tool");

    // Two results for one id is its own protocol error, so a duplicated call must not produce one.
    expect(results).toHaveLength(1);
  });

  test("a conversation with no tool calls at all is untouched", () => {
    const messages = [
      { id: "u1", role: "user", content: "hello" },
      { id: "a1", role: "assistant", content: "hello back" },
    ] as Message[];

    expect(repairUnansweredToolCalls(messages, ids)).toBe(messages);
  });
});
