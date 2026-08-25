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
