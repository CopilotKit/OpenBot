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

/**
 * The history as the durable thread store hands it back.
 *
 * Read back from a stored thread, a tool result arrives BEFORE the assistant message that made the
 * call, and the call's `function.name` is missing. Both are payloads a provider rejects: a tool
 * message with no preceding call, and a call with nothing following it. The model answers that with
 * silence rather than an error, so a Bot that had just read a document said nothing at all and the
 * conversation looked dead.
 *
 * The exact shape below was copied off a real thread after a Google Drive answer went missing.
 */
describe("a history that arrives out of order", () => {
  test("pairs each call with its result, whatever order they arrived in", () => {
    const messages = withoutGuidance(
      toProviderMessages(
        input([
          { id: "1", role: "user", content: "What is in the PRD?" } as Message,
          {
            id: "2",
            role: "tool",
            toolCallId: "c1",
            content: "the document text",
          } as unknown as Message,
          {
            id: "3",
            role: "assistant",
            content: "",
            toolCalls: [call("c1", "read_file_content")],
          } as unknown as Message,
        ]),
      ),
    );

    // Assistant first, then its result. Never a tool message with no call before it.
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "tool"]);
    const answer = messages[2] as { tool_call_id?: string; content?: string };
    expect(answer.tool_call_id).toBe("c1");
    expect(answer.content).toBe("the document text");
  });

  test("gives a nameless call a name, because the provider requires one", () => {
    const messages = withoutGuidance(
      toProviderMessages(
        input([
          {
            id: "1",
            role: "assistant",
            content: "",
            toolCalls: [{ id: "c1", type: "function", function: {} }],
          } as unknown as Message,
        ]),
      ),
    );

    const assistant = messages[0] as {
      tool_calls?: { function: { name: string } }[];
    };
    expect(assistant.tool_calls?.[0]?.function.name).toBe("tool");
  });
});

/**
 * A call read back from the thread store arrives in the store's dialect, not AG-UI's.
 *
 * `{id, name, args}` rather than `{id, type, function: {name, arguments}}`. Reaching straight for
 * `call.function` finds nothing there, and the default underneath turned every restored call into a
 * tool named `tool` with no arguments: the model is shown a call it cannot recognise as the one it
 * made, so it makes it again. That is the repetition the default was written to prevent.
 */
describe("a tool call restored from the thread store", () => {
  test("keeps the name and arguments it was made with", () => {
    const messages = toProviderMessages({
      messages: [
        {
          id: "m1",
          role: "assistant",
          content: null,
          toolCalls: [
            {
              id: "call_1",
              name: "computer_navigate",
              args: '{"url":"https://news.ycombinator.com"}',
            },
          ],
        },
        {
          id: "m2",
          role: "tool",
          toolCallId: "call_1",
          content: '{"ok":true}',
        },
      ],
    } as never);

    const withCalls = messages.find(
      (message: Record<string, unknown>) => message.tool_calls,
    ) as Record<string, unknown>;
    const call = (withCalls.tool_calls as Array<Record<string, unknown>>)[0];
    const fn = call.function as Record<string, unknown>;

    expect(fn.name).toBe("computer_navigate");
    expect(fn.arguments).toBe('{"url":"https://news.ycombinator.com"}');
  });
});
