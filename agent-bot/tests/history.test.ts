import { describe, expect, test } from "bun:test";
import type { RunAgentInput } from "@ag-ui/core";
import { NO_ANSWER_CAME, toProviderMessages } from "../src/history";

/**
 * The Bot that ships in the box, and the conversation a declined handover used to end.
 *
 * `agent-langgraph` was fixed for this and `agent-bot` was not, so the Bot behind the Browser Bot
 * went on failing in exactly the same way. Found by driving it: take the wheel at a sign-in wall,
 * decline to finish, and the next turn answers
 *
 *   400 An assistant message with 'tool_calls' must be followed by tool messages responding to each
 *   'tool_call_id'
 *
 * on screen, in red, for every message after it. These are the same four cases the other Bot has,
 * against this one's provider shape.
 */

type Message = RunAgentInput["messages"][number];

function input(messages: Message[]): RunAgentInput {
  return { messages } as RunAgentInput;
}

function call(id: string, name = "computer_request_help") {
  return { id, type: "function" as const, function: { name, arguments: "{}" } };
}

/** The system prompt is always first and is not what any of this is about. */
function withoutGuidance(messages: ReturnType<typeof toProviderMessages>) {
  return messages.slice(1);
}

describe("a tool call nothing ever answered", () => {
  test("is answered, so the next turn is not refused outright", () => {
    const messages = withoutGuidance(
      toProviderMessages(
        input([
          {
            id: "1",
            role: "user",
            content: "Read my display name.",
          } as Message,
          {
            id: "2",
            role: "assistant",
            content: "",
            toolCalls: [call("c1")],
          } as unknown as Message,
          {
            id: "3",
            role: "user",
            content: "Never mind. What is 17 times 3?",
          } as Message,
        ]),
      ),
    );

    const answer = messages.find(
      (m) =>
        m.role === "tool" &&
        (m as { tool_call_id?: string }).tool_call_id === "c1",
    );
    expect(answer).toBeDefined();
    expect((answer as { content?: string }).content).toBe(NO_ANSWER_CAME);
  });

  test("says no result rather than inventing a successful one", () => {
    // A fake success would have the Bot report reading a page it never reached.
    expect(NO_ANSWER_CAME.toLowerCase()).toContain("no result");
    expect(NO_ANSWER_CAME.toLowerCase()).toContain(
      "do not assume it succeeded",
    );
  });

  test("lands directly after the assistant message that made it", () => {
    /*
     * Position is the requirement, not presence. A provider matches a tool result to the assistant
     * message it follows, so an answer appended at the end of the history fixes nothing.
     */
    const messages = withoutGuidance(
      toProviderMessages(
        input([
          { id: "1", role: "user", content: "Go." } as Message,
          {
            id: "2",
            role: "assistant",
            content: "",
            toolCalls: [call("c1")],
          } as unknown as Message,
          { id: "3", role: "user", content: "Stop." } as Message,
        ]),
      ),
    );

    const assistantAt = messages.findIndex((m) => m.role === "assistant");
    expect(messages[assistantAt + 1]?.role).toBe("tool");
    expect(
      (messages[assistantAt + 1] as { tool_call_id?: string }).tool_call_id,
    ).toBe("c1");
  });

  test("a call that was answered keeps its real answer and gains nothing", () => {
    const messages = withoutGuidance(
      toProviderMessages(
        input([
          {
            id: "1",
            role: "assistant",
            content: "",
            toolCalls: [call("c1", "computer_navigate")],
          } as unknown as Message,
          {
            id: "2",
            role: "tool",
            toolCallId: "c1",
            content: "Example Domain",
          } as unknown as Message,
        ]),
      ),
    );

    const answers = messages.filter((m) => m.role === "tool");
    expect(answers).toHaveLength(1);
    expect((answers[0] as { content?: string }).content).toBe("Example Domain");
  });

  test("several unanswered calls in one message each get their own answer", () => {
    // A provider names every unanswered id, not just the first, so closing one is not enough.
    const messages = withoutGuidance(
      toProviderMessages(
        input([
          {
            id: "1",
            role: "assistant",
            content: "",
            toolCalls: [call("c1"), call("c2", "computer_snapshot")],
          } as unknown as Message,
        ]),
      ),
    );

    const ids = messages
      .filter((m) => m.role === "tool")
      .map((m) => (m as { tool_call_id?: string }).tool_call_id);
    expect(ids).toEqual(["c1", "c2"]);
  });
});
