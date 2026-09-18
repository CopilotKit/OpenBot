import { describe, expect, test } from "bun:test";
import type { RunAgentInput } from "@ag-ui/core";
import { ChatAnthropic } from "@langchain/anthropic";
import {
  AIMessage,
  SystemMessage,
  ToolMessage,
} from "@langchain/core/messages";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { COMPUTER_GUIDANCE } from "../../shared/bot-prompt";
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
    return toLangChainMessages(input([{ role: "user", content }])).at(-1)
      ?.content;
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

/**
 * A run as the server sends it to a remote Bot: the coworker's standing role at the head of the
 * messages, the caller's context beside them, and a skill somebody picked as a system turn just ahead
 * of the message it was picked for.
 *
 * Anthropic and Gemini take one system prompt, at the top, and their LangChain integrations refuse a
 * second before any request is made. With the computer guidance this module puts first, every run
 * the server sends holds at least two.
 */
describe("a provider that takes one system prompt", () => {
  const run = () => {
    const shaped = input([
      {
        id: "standing-role:bot_1",
        role: "system",
        content: "You are Ada, Analyst.",
      },
      { id: "u1", role: "user", content: "Summarise the Q3 filing." },
      { id: "a1", role: "assistant", content: "Revenue rose 4%." },
      { id: "s1", role: "system", content: "Answer in bullet points." },
      { id: "u2", role: "user", content: "Again, shorter." },
    ]);
    shaped.context = [{ description: "A2UI Component Schema", value: "{}" }];
    return shaped;
  };
  // In the order the model is given them: the context beside the run, then the turns.
  const instructions = [
    "A2UI Component Schema\n{}",
    "You are Ada, Analyst.",
    "Answer in bullet points.",
  ];

  test("folds every system message into one at the top, in order", () => {
    for (const provider of ["anthropic", "google"]) {
      const messages = toLangChainMessages(run(), provider);

      const system = messages.filter((m) => m instanceof SystemMessage);
      expect(system).toHaveLength(1);
      expect(messages[0]).toBe(system[0] as SystemMessage);
      const prompt = String(system[0]?.content);
      expect(prompt.startsWith(COMPUTER_GUIDANCE)).toBe(true);
      const at = instructions.map((text) => prompt.indexOf(text));
      expect(at.every((index) => index > 0)).toBe(true);
      expect(at).toEqual([...at].sort((a, b) => a - b));
      expect(messages.slice(1).map((m) => String(m.content))).toEqual([
        "Summarise the Q3 filing.",
        "Revenue rose 4%.",
        "Again, shorter.",
      ]);
    }
  });

  test("is accepted by Anthropic", async () => {
    let sent: { system?: unknown; messages?: { role: string }[] } = {};
    const model = new ChatAnthropic({
      model: "claude-sonnet-4-5",
      apiKey: "sk-ant-test",
      clientOptions: {
        fetch: (async (_url: unknown, init?: RequestInit) => {
          sent = JSON.parse(String(init?.body));
          return Response.json({
            id: "msg_1",
            type: "message",
            role: "assistant",
            model: "claude-sonnet-4-5",
            content: [{ type: "text", text: "- Revenue rose 4%." }],
            stop_reason: "end_turn",
            stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 1 },
          });
        }) as typeof fetch,
      },
    });

    const answer = await model.invoke(toLangChainMessages(run(), "anthropic"));

    expect(answer.content).toBe("- Revenue rose 4%.");
    for (const text of instructions) {
      expect(JSON.stringify(sent.system)).toContain(
        JSON.stringify(text).slice(1, -1),
      );
    }
    expect(sent.messages?.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "user",
    ]);
  });

  test("is accepted by Gemini", async () => {
    let sent: {
      systemInstruction?: unknown;
      contents?: { role: string }[];
    } = {};
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      sent = JSON.parse(String(init?.body));
      return Response.json({
        candidates: [
          {
            content: { role: "model", parts: [{ text: "- Revenue rose 4%." }] },
            finishReason: "STOP",
            index: 0,
          },
        ],
      });
    }) as typeof fetch;
    try {
      const model = new ChatGoogleGenerativeAI({
        model: "gemini-2.5-flash",
        apiKey: "test",
      });

      const answer = await model.invoke(toLangChainMessages(run(), "google"));

      expect(answer.content).toBe("- Revenue rose 4%.");
    } finally {
      globalThis.fetch = realFetch;
    }
    for (const text of instructions) {
      expect(JSON.stringify(sent.systemInstruction)).toContain(
        JSON.stringify(text).slice(1, -1),
      );
    }
    expect(sent.contents?.map((c) => c.role)).toEqual([
      "user",
      "model",
      "user",
    ]);
  });

  test("leaves an OpenAI conversation's system turns where they were", () => {
    // OpenAI takes a system turn anywhere, so a skill stays beside the message it was picked for.
    const messages = toLangChainMessages(run(), "openai");
    expect(
      messages
        .map((m) => (m instanceof SystemMessage ? "system" : String(m.content)))
        .slice(-3),
    ).toEqual(["Revenue rose 4%.", "system", "Again, shorter."]);
    expect(messages.filter((m) => m instanceof SystemMessage)).toHaveLength(4);
  });
});
