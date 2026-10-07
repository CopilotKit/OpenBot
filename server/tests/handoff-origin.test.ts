import { describe, expect, test } from "bun:test";
import { handoffInitiator, PERSON_INITIATOR } from "../src/audit";
import { mintRunAssertion, readOrigin, readRunAssertion } from "../src/agents/callback-token";
import { delegatedWork } from "../src/agents/handoff-tool";

const KEY = "A".repeat(43) + "=";

describe("handoffInitiator", () => {
  test("a hop from a run a trigger started carries the trigger as its origin", () => {
    expect(handoffInitiator("bot_a", { kind: "responsibility", id: "r1" })).toEqual({
      kind: "handoff", id: "bot_a", origin: { kind: "responsibility", id: "r1" },
    });
  });

  test("a second hop keeps the first run's origin rather than nesting", () => {
    const first = handoffInitiator("bot_a", { kind: "responsibility", id: "r1" });
    expect(handoffInitiator("bot_b", first)).toEqual({
      kind: "handoff", id: "bot_b", origin: { kind: "responsibility", id: "r1" },
    });
  });

  test("a hop from a person's run says a person started it", () => {
    expect(handoffInitiator("bot_a", undefined)).toEqual({ kind: "handoff", id: "bot_a", origin: PERSON_INITIATOR });
  });

  test("a hop from a handoff that lost its origin has none, and does not invent one", () => {
    expect(handoffInitiator("bot_b", { kind: "handoff", id: "bot_a" })).toEqual({ kind: "handoff", id: "bot_b" });
  });
});

describe("readOrigin", () => {
  test("reads the roots it knows", () => {
    expect(readOrigin({ kind: "person" })).toEqual({ kind: "person" });
    expect(readOrigin({ kind: "responsibility", id: "r1" })).toEqual({ kind: "responsibility", id: "r1" });
  });

  test("answers unreadable rather than a person for anything else", () => {
    for (const garbled of [undefined, null, "person", { kind: "robot" }, { kind: "routine" }, { kind: "handoff", id: "x" }]) {
      expect(readOrigin(garbled)).toBeUndefined();
    }
  });
});

describe("a signed run assertion", () => {
  test("keeps a handoff's origin through signing", () => {
    const signed = mintRunAssertion(
      { botId: "bot_c", actorId: "u1", runId: "run1", initiator: { kind: "handoff", id: "bot_b", origin: { kind: "responsibility", id: "r1" } } },
      KEY,
    );
    expect(readRunAssertion(signed, KEY)?.initiator).toEqual({
      kind: "handoff", id: "bot_b", origin: { kind: "responsibility", id: "r1" },
    });
  });

  test("drops a garbled origin instead of reading it as a person", () => {
    const signed = mintRunAssertion(
      { botId: "bot_c", actorId: "u1", runId: "run1", initiator: { kind: "handoff", id: "bot_b", origin: { kind: "robot" } as never } },
      KEY,
    );
    expect(readRunAssertion(signed, KEY)?.initiator).toEqual({ kind: "handoff", id: "bot_b" });
  });
});

// Handed-over work may start from any root initiator and keeps a hop's origin.
describe("delegatedWork", () => {
  const WORK = {
    fromBotId: "bot_a",
    toBotId: "bot_b",
    actorId: "u1",
    threadId: "thread-1",
    runId: "run-1",
    depth: 0,
    task: "look into it",
  };

  test("accepts a responsibility as the initiator of delegated work", () => {
    const parsed = delegatedWork.safeParse({ ...WORK, initiator: { kind: "responsibility", id: "r1" } });
    expect(parsed.success && parsed.data.initiator).toEqual({ kind: "responsibility", id: "r1" });
  });

  test("accepts a handoff initiator carrying a responsibility as its origin", () => {
    const parsed = delegatedWork.safeParse({
      ...WORK,
      initiator: { kind: "handoff", id: "bot_a", origin: { kind: "responsibility", id: "r1" } },
    });
    expect(parsed.success && parsed.data.initiator).toEqual({
      kind: "handoff", id: "bot_a", origin: { kind: "responsibility", id: "r1" },
    });
  });
});
