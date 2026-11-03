import { describe, expect, test } from "bun:test";
import type { Message } from "@ag-ui/client";
import { buildResponsibilityTurn } from "@openbot/shared/responsibility-turn";
import { frameFiring } from "@openbot/shared/routine-firing";
import { responsibilityHistory } from "../src/responsibility-history";

/**
 * The filter a responsibility's turn applies to the shared (person, Bot, channel) thread.
 *
 * Every responsibility of one Bot in one conversation shares one thread, so without this a run sends
 * every earlier run of every goal back to the model, and the input grows by a whole run each time
 * (measured: about 1.8k tokens per run, 10k to 29k over 16 runs). The filter keeps this goal's own
 * firings and what answered each of them, and nothing else.
 */

const GOAL_A = "resp-a";
const GOAL_B = "resp-b";

/** A firing exactly as the server writes it: built, framed, and persisted as a user message. */
function firing(id: string, responsibilityId: string): Message {
  return {
    id,
    role: "user",
    content: frameFiring(
      buildResponsibilityTurn({
        instruction: `Watch the PR for ${responsibilityId}.`,
        successCriteria: "Merged.",
        progress: "",
        trigger: { source: "webhook", type: "event" },
        eventData: '<untrusted>{"pr":1}</untrusted>',
        responsibilityId,
      }),
    ),
  } as Message;
}

function call(id: string, name = "report_responsibility_progress") {
  return { id, type: "function", function: { name, arguments: "{}" } };
}

/** One run's answer: a progress call, its result, and a closing line. */
function answer(prefix: string): Message[] {
  return [
    {
      id: `${prefix}-call`,
      role: "assistant",
      content: "",
      toolCalls: [call(`${prefix}-tc`)],
    },
    {
      id: `${prefix}-result`,
      role: "tool",
      toolCallId: `${prefix}-tc`,
      content: "recorded",
    },
    { id: `${prefix}-reply`, role: "assistant", content: `${prefix} done.` },
  ] as Message[];
}

const ids = (messages: Message[]) => messages.map((message) => message.id);

describe("responsibilityHistory", () => {
  test("keeps only this goal's segments out of two interleaved goals and the person's chat", () => {
    const thread: Message[] = [
      { id: "hello", role: "user", content: "Hi, can you watch some PRs?" },
      { id: "hello-reply", role: "assistant", content: "Sure." },
      firing("a1", GOAL_A),
      ...answer("a1"),
      firing("b1", GOAL_B),
      ...answer("b1"),
      { id: "chat", role: "user", content: "How is it going?" },
      { id: "chat-reply", role: "assistant", content: "Fine." },
      firing("a2", GOAL_A),
      ...answer("a2"),
      firing("b2", GOAL_B),
      ...answer("b2"),
    ] as Message[];

    expect(ids(responsibilityHistory(thread, GOAL_A))).toEqual([
      "a1",
      "a1-call",
      "a1-result",
      "a1-reply",
      "a2",
      "a2-call",
      "a2-result",
      "a2-reply",
    ]);
    expect(ids(responsibilityHistory(thread, GOAL_B))).toEqual([
      "b1",
      "b1-call",
      "b1-result",
      "b1-reply",
      "b2",
      "b2-call",
      "b2-result",
      "b2-reply",
    ]);
  });

  test("never splits a tool call from its result: every kept call has its result and vice versa", () => {
    const thread: Message[] = [
      firing("a1", GOAL_A),
      ...answer("a1"),
      firing("b1", GOAL_B),
      ...answer("b1"),
      firing("a2", GOAL_A),
      ...answer("a2"),
    ] as Message[];

    const kept = responsibilityHistory(thread, GOAL_A);
    const calls = kept.flatMap((message) =>
      message.role === "assistant"
        ? (message.toolCalls ?? []).map((toolCall) => toolCall.id)
        : [],
    );
    const results = kept.flatMap((message) =>
      message.role === "tool" ? [message.toolCallId] : [],
    );
    expect(calls).toEqual(["a1-tc", "a2-tc"]);
    expect(results).toEqual(calls);
  });

  test("drops a call left dangling in this goal's own segment rather than sending it", () => {
    const thread: Message[] = [
      firing("a1", GOAL_A),
      {
        id: "a1-call",
        role: "assistant",
        content: "",
        toolCalls: [call("a1-tc")],
      },
      // The run was interrupted here: the result never landed.
      firing("b1", GOAL_B),
      ...answer("b1"),
    ] as Message[];

    expect(ids(responsibilityHistory(thread, GOAL_A))).toEqual(["a1"]);
  });

  test("the first-ever run of a goal sends no history at all", () => {
    expect(responsibilityHistory([], GOAL_A)).toEqual([]);
    const othersOnly: Message[] = [
      { id: "hello", role: "user", content: "Hi." },
      { id: "hello-reply", role: "assistant", content: "Hello." },
      firing("b1", GOAL_B),
      ...answer("b1"),
    ] as Message[];
    expect(responsibilityHistory(othersOnly, GOAL_A)).toEqual([]);
  });

  test("does not take a person's message that merely quotes the goal's id as a firing of it", () => {
    const thread: Message[] = [
      firing("a1", GOAL_A),
      ...answer("a1"),
      {
        id: "quote",
        role: "user",
        content: `What does ${GOAL_A} do?`,
      },
      { id: "quote-reply", role: "assistant", content: "It watches a PR." },
    ] as Message[];

    expect(ids(responsibilityHistory(thread, GOAL_A))).toEqual([
      "a1",
      "a1-call",
      "a1-result",
      "a1-reply",
    ]);
  });

  test("returns new arrays and the kept messages unchanged, without mutating its input", () => {
    const thread: Message[] = [firing("a1", GOAL_A), ...answer("a1")];
    const copy = structuredClone(thread);
    const kept = responsibilityHistory(thread, GOAL_A);
    expect(thread).toEqual(copy);
    expect(kept).not.toBe(thread);
    expect(kept[0]).toBe(thread[0] as Message);
  });
});
