import { describe, expect, test } from "bun:test";
import { readableTurns } from "@/lib/copilot/thread-messages";

/**
 * What comes back out of the history store, and what is refused at the door.
 *
 * The old reader cast whatever it was given to `Message[]`, so a turn the store held in some other
 * shape reached every projection that draws a transcript — and one of them dereferenced
 * `toolCall.function.arguments`, which took the conversation down rather than the turn.
 *
 * These are the shapes that have actually been seen, not invented ones: the tool call persisted as
 * `{id, name, args}` comes from #199, which found seventeen of them in one thread after interrupted
 * runs, and the content shapes come from the tests on #43.
 */

const userTurn = { id: "m1", role: "user", content: "What did I miss?" };

const assistantTurn = {
  id: "m2",
  role: "assistant",
  content: "Here is the summary.",
};

/** As AG-UI defines a tool call: a literal `function` type, with the call nested under it. */
const wellFormedToolCall = {
  id: "m3",
  role: "assistant",
  toolCalls: [
    {
      id: "call_1",
      type: "function",
      function: { name: "search_files", arguments: "{}" },
    },
  ],
};

describe("reading back a stored thread", () => {
  test("an ordinary conversation comes back whole, with nothing counted", () => {
    const { messages, unreadable } = readableTurns([userTurn, assistantTurn]);
    expect(messages).toHaveLength(2);
    expect(unreadable).toBe(0);
  });

  test("a well-formed tool call survives", () => {
    // The shape the transcript knows how to draw. If validation rejected this, the fix would have
    // traded a crash for an empty conversation.
    const { messages, unreadable } = readableTurns([wellFormedToolCall]);
    expect(messages).toHaveLength(1);
    expect(unreadable).toBe(0);
  });

  test("a tool call stored the LangChain way is dropped and counted", () => {
    /*
     * The turn from #199: `{id, name, args}` rather than `{id, type: "function", function: {…}}`.
     * This is the one that crashed a renderer reading `toolCall.function.arguments`, so the whole
     * turn has to not arrive — and the count is what stops it vanishing quietly.
     */
    const langChainShaped = {
      id: "m4",
      role: "assistant",
      toolCalls: [{ id: "call_2", name: "search_files", args: {} }],
    };

    const { messages, unreadable } = readableTurns([
      userTurn,
      langChainShaped,
      assistantTurn,
    ]);

    expect(messages.map((message) => message.id)).toEqual(["m1", "m2"]);
    expect(unreadable).toBe(1);
  });

  test("multimodal content is not mistaken for a malformed turn", () => {
    // AG-UI allows content as typed parts as well as a string, so a turn carrying an image is
    // ordinary. Rejecting it would lose real messages in the name of safety.
    const withParts = {
      id: "m5",
      role: "user",
      content: [{ type: "text", text: "What is in this?" }],
    };
    const { messages, unreadable } = readableTurns([withParts]);
    expect(messages).toHaveLength(1);
    expect(unreadable).toBe(0);
  });

  test("content that is not content is dropped rather than drawn as empty", () => {
    /*
     * From the #43 cases. These used to reach a projection and resolve to an empty message, so the
     * transcript showed a turn that said nothing and read as though somebody had sent a blank line.
     * Refused here instead, and reported.
     */
    const shapes = [
      { id: "a", role: "user" },
      { id: "b", role: "user", content: null },
      { id: "c", role: "user", content: 42 },
      { id: "d", role: "user", content: [null, "text", 7] },
    ];

    const { messages, unreadable } = readableTurns(shapes);
    expect(messages).toEqual([]);
    expect(unreadable).toBe(4);
  });

  test("a turn that is not an object at all is dropped", () => {
    const { messages, unreadable } = readableTurns([
      null,
      "a string",
      7,
      userTurn,
    ]);
    expect(messages.map((message) => message.id)).toEqual(["m1"]);
    expect(unreadable).toBe(3);
  });

  test("a turn with no recognised role is dropped", () => {
    // The schema is a union on `role`, so an unknown one matches no member.
    const { messages, unreadable } = readableTurns([
      { id: "x", role: "narrator", content: "once upon a time" },
    ]);
    expect(messages).toEqual([]);
    expect(unreadable).toBe(1);
  });

  test("order is the stored order, so a dropped turn does not reshuffle the rest", () => {
    const { messages } = readableTurns([
      assistantTurn,
      { id: "bad", role: "assistant", toolCalls: [{ id: "c", name: "n" }] },
      userTurn,
    ]);
    expect(messages.map((message) => message.id)).toEqual(["m2", "m1"]);
  });

  test("a turn that parses keeps the fields the schema does not name", () => {
    /*
     * The reason the original object is returned rather than `parsed.data`. Zod strips unknown keys,
     * so handing back the parsed copy would make this a silent rewrite of every message that passed
     * — dropping whatever the runtime carries that this file has not heard of.
     */
    const carrying = { ...userTurn, somethingTheRuntimeAdded: "keep me" };
    const { messages } = readableTurns([carrying]);
    expect(
      (messages[0] as unknown as { somethingTheRuntimeAdded?: string })
        .somethingTheRuntimeAdded,
    ).toBe("keep me");
  });

  test("an empty history is not a failure", () => {
    expect(readableTurns([])).toEqual({ messages: [], unreadable: 0 });
  });

  test("a thread where nothing parses reports every turn", () => {
    // The case that must not read as "this conversation is empty": the transcript has nothing to
    // draw, so the count is the only thing that tells the person their history is still there.
    const { messages, unreadable } = readableTurns([{ nope: true }, 1, null]);
    expect(messages).toEqual([]);
    expect(unreadable).toBe(3);
  });
});
