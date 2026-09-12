import { describe, expect, test } from "bun:test";
import type { RunAgentInput } from "@ag-ui/core";
import {
  AIMessage,
  SystemMessage,
  ToolMessage,
} from "@langchain/core/messages";
import { NO_ANSWER_CAME, toLangChainMessages } from "../src/history";

/**
 * A tool call nobody answered does not end the conversation.
 *
 * A call the surface owns ends the run without a result on purpose: the surface draws it, or puts it
 * to a person, and starts the next run carrying the answer. When nobody answers — a Bot asks for the
 * wheel to get past a sign-in and the person decides they do not need it after all — no answer is
 * ever carried, and the call sits in the history with nothing following it.
 *
 * OpenAI rejects that on the NEXT turn: "an assistant message with 'tool_calls' must be followed by
 * tool messages responding to each 'tool_call_id'". So the conversation was not stuck on that one
 * request, it was finished: every later message failed identically, and the only way out was a new
 * conversation, which loses this one.
 */
const input = (messages: unknown[]): RunAgentInput =>
  ({ messages }) as unknown as RunAgentInput;

const assistantAsking = {
  role: "assistant",
  content: "",
  toolCalls: [
    {
      id: "call_1",
      function: { name: "computer_request_help", arguments: "{}" },
    },
  ],
};

test("passes the caller's A2UI catalog and tool instructions to the model", () => {
  // The live failure emitted `type: "card"` instead of `component: "Card"`: the model saw the
  // permissive render_a2ui tool schema, but this adapter had discarded its actual catalog context.
  const catalog = JSON.stringify({
    catalogId: "https://a2ui.org/specification/v0_9/basic_catalog.json",
    components: {
      Card: {
        properties: { component: { const: "Card" }, child: { type: "string" } },
      },
    },
  });
  const instructions =
    "Use flat components with component names from the catalog. Button actions use event.name and event.context.";
  const run = input([
    { role: "user", content: "Show a Trip preferences card." },
  ]);
  run.context = [
    { description: "A2UI Component Schema", value: catalog },
    { description: "A2UI render tool usage guide", value: instructions },
  ];
  const messages = toLangChainMessages(run);
  const system = messages.filter((message) => message instanceof SystemMessage);
  expect(system.map((message) => message.content)).toContain(
    `A2UI Component Schema\n${catalog}`,
  );
  expect(system.map((message) => message.content)).toContain(
    `A2UI render tool usage guide\n${instructions}`,
  );
  expect(messages.at(-1)?.content).toBe("Show a Trip preferences card.");
});

describe("history with a tool call nobody answered", () => {
  test("closes it, so the next turn is not rejected", () => {
    const messages = toLangChainMessages(
      input([{ role: "user", content: "open a page" }, assistantAsking]),
    );

    const closing = messages.find(
      (message): message is ToolMessage =>
        message instanceof ToolMessage &&
        (message as ToolMessage).tool_call_id === "call_1",
    );
    expect(closing).toBeDefined();
    expect(String(closing?.content)).toBe(NO_ANSWER_CAME);
  });

  test("puts the result immediately after the call that made it", () => {
    /*
     * Position is the requirement, not merely presence. A tool result has to follow the assistant
     * message carrying the call; appended at the end of a longer history it would be rejected for
     * the same reason the missing one was.
     */
    const messages = toLangChainMessages(
      input([
        { role: "user", content: "open a page" },
        assistantAsking,
        { role: "user", content: "never mind, what is 17 times 3?" },
      ]),
    );

    const asked = messages.findIndex((m) => m instanceof AIMessage);
    expect(messages[asked + 1]).toBeInstanceOf(ToolMessage);
  });

  test("leaves a call that was answered alone", () => {
    // The ordinary path. Inventing a second result for a call that already has one would tell the
    // model its tool ran twice.
    const messages = toLangChainMessages(
      input([
        assistantAsking,
        { role: "tool", toolCallId: "call_1", content: "the real answer" },
      ]),
    );

    const results = messages.filter(
      (m): m is ToolMessage => m instanceof ToolMessage,
    );
    expect(results).toHaveLength(1);
    expect(String(results[0]?.content)).toBe("the real answer");
  });

  test("closes only the calls that are missing one", () => {
    const messages = toLangChainMessages(
      input([
        {
          role: "assistant",
          content: "",
          toolCalls: [
            { id: "answered", function: { name: "a", arguments: "{}" } },
            { id: "orphan", function: { name: "b", arguments: "{}" } },
          ],
        },
        { role: "tool", toolCallId: "answered", content: "real" },
      ]),
    );

    const byId = new Map(
      messages
        .filter((m): m is ToolMessage => m instanceof ToolMessage)
        .map((m) => [m.tool_call_id, String(m.content)]),
    );
    expect(byId.get("answered")).toBe("real");
    expect(byId.get("orphan")).toBe(NO_ANSWER_CAME);
  });
});
