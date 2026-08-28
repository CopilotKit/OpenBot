import { describe, expect, test } from "bun:test";
import { readableTurns } from "../src/lib/copilot/thread-messages";

/**
 * Reading back a conversation that used a tool.
 *
 * The shapes below are copied from a live thread rather than invented. The store writes a tool call
 * as `{id, name, args}`; AG-UI describes `{id, type: "function", function: {name, arguments}}`. A
 * reader that insists on the second and refuses the first throws away every turn in which a Bot did
 * anything, which is the half of the conversation worth keeping.
 */
const userTurn = {
  id: "6953d56c",
  role: "user",
  content: "open hackernews.com and tell me the top 3 stories",
};

/** As the history store writes it. */
const storedToolCall = {
  id: "0fe7b049",
  role: "assistant",
  toolCalls: [
    {
      id: "call_maB4q3",
      name: "computer_navigate",
      args: '{"url":"https://news.ycombinator.com"}',
    },
  ],
};

const toolResult = {
  id: "aa5e9452",
  role: "tool",
  toolCallId: "call_maB4q3",
  content: '{"ok":true,"title":"Hacker News"}',
};

const answer = { id: "5c1f", role: "assistant", content: "Top 3 stories…" };

describe("restoring a conversation that used a tool", () => {
  test("a browsing turn survives the read", () => {
    const { messages, unreadable } = readableTurns([
      userTurn,
      storedToolCall,
      toolResult,
      answer,
    ]);

    // Every one of them, and the tool call above all: without it the transcript keeps the sentence
    // the Bot wrote and loses the browsing that produced it.
    expect(messages).toHaveLength(4);
    expect(unreadable).toBe(0);
  });

  test("the tool call comes back in the shape every renderer reads", () => {
    const { messages } = readableTurns([storedToolCall]);
    expect(messages[0]).toMatchObject({
      role: "assistant",
      toolCalls: [
        {
          id: "call_maB4q3",
          type: "function",
          function: {
            name: "computer_navigate",
            arguments: '{"url":"https://news.ycombinator.com"}',
          },
        },
      ],
    });
  });

  test("a call already in AG-UI's shape is left alone", () => {
    const already = {
      id: "x",
      role: "assistant",
      toolCalls: [
        {
          id: "c1",
          type: "function",
          function: { name: "computer_click", arguments: "{}" },
        },
      ],
    };
    const { messages, unreadable } = readableTurns([already]);
    expect(unreadable).toBe(0);
    expect(messages[0]).toEqual(already as never);
  });

  test("a turn that is genuinely malformed is still refused", () => {
    /*
     * The guard is not being removed, only taught a second spelling. A tool call with neither shape
     * is something no renderer can draw, and letting it through is how one bad turn used to take a
     * whole conversation down.
     */
    const nonsense = { id: "y", role: "assistant", toolCalls: [{ id: "c2" }] };
    const { messages, unreadable } = readableTurns([nonsense]);
    expect(messages).toHaveLength(0);
    expect(unreadable).toBe(1);
  });

  test("a mixed array is refused rather than half-translated", () => {
    // Guessing at half of it would be this file inventing history rather than reading it.
    const mixed = {
      id: "z",
      role: "assistant",
      toolCalls: [
        { id: "a", name: "one", args: "{}" },
        {
          id: "b",
          type: "function",
          function: { name: "two", arguments: "{}" },
        },
      ],
    };
    expect(readableTurns([mixed]).unreadable).toBe(1);
  });

  test("everything else passes through untouched", () => {
    const { messages, unreadable } = readableTurns([userTurn, answer]);
    expect(unreadable).toBe(0);
    expect(messages[0]).toEqual(userTurn as never);
  });
});

/**
 * The cases the rewrite dropped, plus the one it never had.
 *
 * A reader that translates between two dialects is exactly where a quiet data-loss bug lives, and
 * these are the shapes a real thread contains: arguments the store kept as an object, content that
 * is a list of parts rather than a string, a turn with no content at all, and an order that has to
 * survive the trip because a conversation read out of sequence is not the conversation.
 */
describe("shapes a real thread contains", () => {
  test("arguments the store kept as an object become a string", () => {
    const [turn] = readableTurns([
      {
        id: "m1",
        role: "assistant",
        toolCalls: [
          { id: "c1", name: "computer_navigate", args: { url: "https://x" } },
        ],
      },
    ]).messages as Array<Record<string, unknown>>;

    const call = (turn.toolCalls as Array<Record<string, unknown>>)[0];
    const fn = call.function as Record<string, unknown>;
    /*
     * AG-UI types this as a string. Passing the object through produced a call that looked
     * translated and still failed validation, so the turn was dropped anyway: this function's own
     * bug, one layer down.
     */
    expect(typeof fn.arguments).toBe("string");
    expect(JSON.parse(fn.arguments as string)).toEqual({ url: "https://x" });
  });

  test("a string of arguments is passed through exactly", () => {
    const [turn] = readableTurns([
      {
        id: "m1",
        role: "assistant",
        toolCalls: [{ id: "c1", name: "t", args: '{"url": "https://x"}' }],
      },
    ]).messages as Array<Record<string, unknown>>;

    const call = (turn.toolCalls as Array<Record<string, unknown>>)[0];
    // Down to the whitespace: it may be a fragment of a stream that was never valid JSON, and
    // re-encoding it would change what the model actually said.
    expect((call.function as Record<string, unknown>).arguments).toBe(
      '{"url": "https://x"}',
    );
  });

  /*
   * A call with no arguments at all. Not `args` missing entirely, which the dialect check refuses on
   * purpose so that it never rewrites something that was not a stored call in the first place.
   */
  test("a call with empty arguments becomes something a reader can parse", () => {
    const [turn] = readableTurns([
      {
        id: "m1",
        role: "assistant",
        toolCalls: [{ id: "c1", name: "t", args: null }],
      },
    ]).messages as Array<Record<string, unknown>>;

    const call = (turn.toolCalls as Array<Record<string, unknown>>)[0];
    expect((call.function as Record<string, unknown>).arguments).toBe("{}");
  });

  /*
   * A turn that called a tool and said nothing alongside it is written exactly this way, and it was
   * being dropped: the same loss the tool-call dialect caused, arriving by a different route. The
   * schema makes an assistant's content optional and does not allow null, so the two say the same
   * thing and only one parsed.
   */
  test("an assistant turn that said nothing while it worked survives", () => {
    const { messages, unreadable } = readableTurns([
      {
        id: "m1",
        role: "assistant",
        content: null,
        toolCalls: [{ id: "c1", name: "computer_navigate", args: "{}" }],
      },
    ]);

    expect(messages).toHaveLength(1);
    expect(unreadable).toBe(0);
  });

  /*
   * And a person's turn is not the same case. Content is required there, so `null` is not a message
   * somebody sent: it used to reach a projection and draw as a blank line. Refused and counted, so
   * the surface can say so, which is the decision #207 made and this does not disturb.
   */
  test("a person's turn with no content is still refused and counted", () => {
    const { messages, unreadable } = readableTurns([
      { id: "m1", role: "user", content: null },
    ]);

    expect(messages).toEqual([]);
    expect(unreadable).toBe(1);
  });

  test("content that is a list of parts survives", () => {
    const content = [{ type: "text", text: "What is in this?" }];

    const { messages, unreadable } = readableTurns([
      { id: "m1", role: "user", content },
    ]);

    expect(messages).toHaveLength(1);
    expect(unreadable).toBe(0);
  });

  test("the order of the conversation is the order it came in", () => {
    const read = readableTurns([
      { id: "m1", role: "user", content: "one" },
      {
        id: "m2",
        role: "assistant",
        toolCalls: [
          { id: "c1", name: "computer_navigate", args: { url: "u" } },
        ],
      },
      { id: "m3", role: "assistant", content: "three" },
    ]).messages as Array<Record<string, unknown>>;

    expect(read.map((m) => m.role)).toEqual(["user", "assistant", "assistant"]);
    expect(read[0]?.content).toBe("one");
    expect(read[2]?.content).toBe("three");
  });
});
