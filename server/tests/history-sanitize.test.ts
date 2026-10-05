import { describe, expect, test } from "bun:test";
import type { Message } from "@ag-ui/client";
import { sanitizeSeededHistory } from "../src/agents/history-sanitize";

/**
 * The filter itself, asserted as a function rather than through either turn path.
 *
 * Both callers reach it through machinery of their own: a routine seeds history off the platform
 * (`routine-run-turn.test.ts`) and a chat turn is handed it by the browser (`copilot.test.ts`). Those
 * files assert that the guard IS applied where it has to be. The rules it applies are asserted once,
 * here, because they are the same rules on both paths and neither path is a good place to enumerate
 * them.
 */

/** History rows are written in the platform's shape and cast once, as the callers do. */
function history(rows: unknown[]): Message[] {
  return rows as Message[];
}

function call(id: string, name = "search", args = "{}") {
  return { id, type: "function", function: { name, arguments: args } };
}

describe("sanitizeSeededHistory", () => {
  test("drops an unanswered call and keeps the answered one, with all text intact", () => {
    const sanitized = sanitizeSeededHistory(
      history([
        { id: "m1", role: "user", content: "Look two things up." },
        {
          id: "m2",
          role: "assistant",
          content: "Looking them up.",
          toolCalls: [call("call_answered"), call("call_dangling")],
        },
        {
          id: "m3",
          role: "tool",
          content: "found x",
          toolCallId: "call_answered",
        },
        { id: "m4", role: "assistant", content: "Here is x." },
      ]),
    );

    expect(sanitized.map((message) => message.id)).toEqual([
      "m1",
      "m2",
      "m3",
      "m4",
    ]);
    expect(sanitized[1]).toMatchObject({
      content: "Looking them up.",
      toolCalls: [call("call_answered")],
    });
  });

  test("drops an assistant message whose only content was a dangling call", () => {
    // An assistant row with neither text nor tool calls is itself invalid for some providers, so
    // stripping the call is not enough: the husk has to go too.
    const sanitized = sanitizeSeededHistory(
      history([
        { id: "m1", role: "user", content: "Look it up." },
        { id: "m2", role: "assistant", toolCalls: [call("call_dangling")] },
        { id: "m3", role: "user", content: "Anything?" },
      ]),
    );

    expect(sanitized.map((message) => message.id)).toEqual(["m1", "m3"]);
  });

  test("keeps text a message did say, minus the call it cannot complete", () => {
    const sanitized = sanitizeSeededHistory(
      history([
        {
          id: "m1",
          role: "assistant",
          content: "Let me check.",
          toolCalls: [call("call_dangling")],
        },
      ]),
    );

    expect(sanitized).toHaveLength(1);
    expect(sanitized[0]).toEqual({
      id: "m1",
      role: "assistant",
      content: "Let me check.",
    } as unknown as Message);
  });

  test("drops an orphaned tool result", () => {
    // The mirror-image dangle: a result whose call is not in the history at all.
    const sanitized = sanitizeSeededHistory(
      history([
        { id: "m1", role: "user", content: "Hello." },
        { id: "m2", role: "tool", content: "left over", toolCallId: "gone" },
        { id: "m3", role: "assistant", content: "Hello back." },
      ]),
    );

    expect(sanitized.map((message) => message.id)).toEqual(["m1", "m3"]);
  });

  test("a result that lands after a later user message answers nothing", () => {
    const history = [
      { id: "u1", role: "user", content: "do it" },
      {
        id: "a1",
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "late",
            type: "function",
            function: { name: "x", arguments: "{}" },
          },
        ],
      },
      { id: "u2", role: "user", content: "also this" },
      {
        id: "t1",
        role: "tool",
        toolCallId: "late",
        content: "arrived too late",
      },
    ] as unknown as Message[];
    const out = sanitizeSeededHistory(history);
    expect(out.map((m) => m.id)).toEqual(["u1", "u2"]);
  });

  test("a result ahead of its own call answers nothing", () => {
    // Position, not mere presence: no provider accepts a result that arrives before the call it
    // belongs to, so a history in that order is still a history to be repaired.
    const sanitized = sanitizeSeededHistory(
      history([
        { id: "m1", role: "tool", content: "early", toolCallId: "call_1" },
        { id: "m2", role: "assistant", toolCalls: [call("call_1")] },
      ]),
    );

    expect(sanitized).toEqual([]);
  });

  test("a result that lands after a system row still answers its call", () => {
    /*
     * The model API stops at a user OR a system row, but it checks the CONVERTED messages, and a
     * built-in Bot drops every system row on the way there because neither forwarding flag is set.
     * A skill's instructions arrive as exactly such a row, inserted ahead of the person's message,
     * so a boundary here would drop a call the request carries fine.
     */
    const sanitized = sanitizeSeededHistory(
      history([
        { id: "u1", role: "user", content: "do it" },
        { id: "a1", role: "assistant", toolCalls: [call("call_1")] },
        { id: "s1", role: "system", content: "Use the audit skill." },
        { id: "t1", role: "tool", content: "done", toolCallId: "call_1" },
        { id: "u2", role: "user", content: "and then?" },
      ]),
    );

    expect(sanitized.map((message) => message.id)).toEqual([
      "u1",
      "a1",
      "s1",
      "t1",
      "u2",
    ]);
  });

  test("a result ahead of its call is dropped even when a real answer follows", () => {
    // The trailing result answers the call, so the call and that result survive. The leading one
    // answers nothing where it sits, and a `tool` row ahead of any call is a shape a provider
    // refuses on its own — the browser's `repair-history.ts` relocates it; here it is dropped.
    const sanitized = sanitizeSeededHistory(
      history([
        { id: "m1", role: "tool", content: "early", toolCallId: "call_1" },
        { id: "m2", role: "assistant", toolCalls: [call("call_1")] },
        { id: "m3", role: "tool", content: "on time", toolCallId: "call_1" },
      ]),
    );

    expect(sanitized.map((message) => message.id)).toEqual(["m2", "m3"]);
  });

  test("a second answer to a call already answered is dropped", () => {
    const sanitized = sanitizeSeededHistory(
      history([
        { id: "m1", role: "assistant", toolCalls: [call("call_1")] },
        { id: "m2", role: "tool", content: "first", toolCallId: "call_1" },
        { id: "m3", role: "tool", content: "again", toolCallId: "call_1" },
      ]),
    );

    expect(sanitized.map((message) => message.id)).toEqual(["m1", "m2"]);
  });

  test("a clean history passes through unchanged, object for object", () => {
    const clean = history([
      { id: "m1", role: "user", content: "Look it up." },
      {
        id: "m2",
        role: "assistant",
        content: "Looking it up.",
        toolCalls: [call("call_1")],
      },
      { id: "m3", role: "tool", content: "found", toolCallId: "call_1" },
      { id: "m4", role: "assistant", content: "Here it is." },
    ]);
    const snapshot = structuredClone(clean);

    const sanitized = sanitizeSeededHistory(clean);

    // Nothing reordered, nothing rewritten, and not even reallocated, so there is no room for a
    // silent normalization to creep in on the overwhelmingly common healthy-thread path.
    expect(sanitized).toEqual(snapshot);
    for (const [index, message] of sanitized.entries()) {
      expect(message).toBe(clean[index] as Message);
    }
    // And the caller's array was not mutated underneath it.
    expect(clean).toEqual(snapshot);
  });
});

/*
 * The second parameter is the interrupt resume, and it exists because the runtime answers those
 * calls AFTER this pass has run. Dropping one would leave the appended tool result pointing at a
 * call that is no longer in the conversation: the same error, reached from the other side.
 */
describe("a call answered elsewhere survives", () => {
  test("an id named by the caller is kept, and the message is the very same object", () => {
    const rows = history([
      { id: "m1", role: "user", content: "Book it." },
      {
        id: "m2",
        role: "assistant",
        content: "Asking first.",
        toolCalls: [call("interrupt_1", "confirm")],
      },
    ]);

    const sanitized = sanitizeSeededHistory(rows, new Set(["interrupt_1"]));

    expect(sanitized).toHaveLength(2);
    expect(sanitized[1]).toBe(rows[1] as Message);
  });

  test("it also saves a message that would otherwise have been dropped as a husk", () => {
    const rows = history([
      { id: "m1", role: "assistant", toolCalls: [call("interrupt_1")] },
    ]);

    expect(sanitizeSeededHistory(rows, new Set(["interrupt_1"]))).toHaveLength(
      1,
    );
    // And without the resume it is the husk case again, which is what makes the parameter load-bearing.
    expect(sanitizeSeededHistory(rows)).toEqual([]);
  });

  test("only the named ids are spared, alongside the ones the history answers", () => {
    const sanitized = sanitizeSeededHistory(
      history([
        {
          id: "m1",
          role: "assistant",
          content: "Two things.",
          toolCalls: [
            call("interrupt_1"),
            call("call_answered"),
            call("call_dangling"),
          ],
        },
        { id: "m2", role: "tool", content: "ok", toolCallId: "call_answered" },
      ]),
      new Set(["interrupt_1"]),
    );

    expect(sanitized[0]).toMatchObject({
      toolCalls: [call("interrupt_1"), call("call_answered")],
    });
  });

  test("an empty set is the default, and changes nothing", () => {
    const rows = history([
      { id: "m1", role: "assistant", toolCalls: [call("call_dangling")] },
    ]);

    expect(sanitizeSeededHistory(rows, new Set())).toEqual(
      sanitizeSeededHistory(rows),
    );
  });
});
