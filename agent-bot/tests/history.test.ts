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

test("passes AG-UI catalog context to the model while preserving prompt and history order", () => {
  const run = input([
    { id: "standing", role: "system", content: "Help with travel planning." },
    { id: "request", role: "user", content: "Draw a trip card." },
  ]);
  const withoutContext = toProviderMessages(run);
  const catalog = JSON.stringify({
    components: { Card: { properties: { component: { const: "Card" } } } },
  });
  run.context = [
    { description: "A2UI Component Schema", value: catalog },
    {
      description: "A2UI render tool usage guide",
      value: "Actions use event.name.",
    },
  ];

  expect(toProviderMessages(run)).toEqual([
    withoutContext[0],
    { role: "system", content: `A2UI Component Schema\n${catalog}` },
    {
      role: "system",
      content: "A2UI render tool usage guide\nActions use event.name.",
    },
    ...withoutContext.slice(1),
  ]);
  expect(run.messages).toHaveLength(2);
  run.context = [];
  expect(toProviderMessages(run)).toEqual(withoutContext);
});

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

    const withCalls = messages.find((message) => message.role === "assistant");
    const fn = withCalls?.tool_calls?.[0]?.function;

    expect(fn?.name).toBe("computer_navigate");
    expect(fn?.arguments).toBe('{"url":"https://news.ycombinator.com"}');
  });
});

/**
 * A message somebody attached a file to.
 *
 * The composer sends it as a list of parts rather than a string: what the person typed, then the
 * file. `copilot.ts` resolves the file before the run leaves the server, so a text file arrives here
 * as a text part and an image as an `image` part carrying its bytes. `String()` of that list is
 * `[object Object],[object Object]`, and that is what the model was sent in place of the question and
 * the file both.
 */
describe("a message with a file attached", () => {
  const typed = { type: "text", text: "How many rows say failed?" };
  const csv = 'Attached file "runs.csv":\n\nid,status\n1,failed\n2,ok';

  function userContent(content: unknown) {
    const [user] = withoutGuidance(
      toProviderMessages(
        input([{ id: "1", role: "user", content } as unknown as Message]),
      ),
    );
    return user?.content;
  }

  test("keeps what the person typed and the text of the file", () => {
    expect(userContent([typed, { type: "text", text: csv }])).toEqual([
      { type: "text", text: "How many rows say failed?" },
      { type: "text", text: csv },
    ]);
  });

  test("puts an attached image in front of the model", () => {
    const image = {
      type: "image",
      source: { type: "data", value: "iVBORw0KGgo=", mimeType: "image/png" },
      metadata: { attachmentId: "a1", filename: "chart.png" },
    };
    expect(userContent([typed, image])).toEqual([
      { type: "text", text: "How many rows say failed?" },
      {
        type: "image_url",
        image_url: { url: "data:image/png;base64,iVBORw0KGgo=" },
      },
    ]);
  });

  test("names a part it cannot read rather than dropping it", () => {
    // A model told "[audio]" can say something was attached that it cannot hear. A model handed
    // nothing answers as though nothing was attached.
    const audio = {
      type: "audio",
      source: { type: "data", value: "UklGRg==", mimeType: "audio/wav" },
    };
    expect(userContent([typed, audio])).toEqual([
      { type: "text", text: "How many rows say failed?" },
      { type: "text", text: "[audio]" },
    ]);
  });

  test("sends a message that is only text exactly as it was typed", () => {
    // Nearly every message. Unchanged by this, and pinned so it stays that way.
    expect(userContent("What is 17 times 3?")).toBe("What is 17 times 3?");
  });
});
