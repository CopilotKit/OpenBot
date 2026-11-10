import { expect, test } from "bun:test";
import { runModeOf } from "../src/agents/run-mode";
import { proactiveInitiator } from "../src/proactive/initiator";

/**
 * Who is watching a run, read from the initiators the server really writes: a person's turn, a
 * routine firing (`routines/runner.ts`), a follow-up the Bot set (`agents/wake-up.ts`), a check-in
 * (`proactive/initiator.ts`), a goal's run, and a handoff, which runs as whatever started the chain.
 */
test.each([
  ["a browser request, which carries none", undefined, "attended"],
  ["a person's turn", { kind: "person" }, "attended"],
  ["a routine firing", { kind: "routine", id: "routine-1" }, "routine"],
  ["a follow-up", { kind: "routine", id: "follow-up:item-1" }, "routine"],
  ["a goal's run", { kind: "responsibility", id: "goal-1" }, "routine"],
  ["a check-in", proactiveInitiator("run-1"), "check-in"],
  [
    "a handoff from a person",
    { kind: "handoff", id: "bot-a", origin: { kind: "person" } },
    "attended",
  ],
  [
    "a handoff from a routine",
    {
      kind: "handoff",
      id: "bot-a",
      origin: { kind: "routine", id: "routine-1" },
    },
    "routine",
  ],
] as const)("%s: the run mode is right", (_, initiator, mode) => {
  expect(runModeOf(initiator as Parameters<typeof runModeOf>[0])).toBe(mode);
});
