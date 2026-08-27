import { describe, expect, test } from "bun:test";
import type { HandoffDesk, HandoffOutcome } from "../src/agents/handoff";
import {
  HANDED_OVER,
  HANDOFF_TOOL,
  handoffTool,
} from "../src/agents/handoff-tool";

/**
 * What the model is offered, and what it is told when it is refused.
 *
 * A tool a Bot may never successfully use is worse than no tool: the model spends attention on it,
 * calls it, and tells the person it tried and could not, which reads as the deployment being broken
 * rather than as it working correctly.
 */

const FROM = {
  botId: "assistant",
  actorId: "user-1",
  runId: "run-1",
  threadId: "thread-1",
  depth: 0,
};

function deskReturning(outcome: HandoffOutcome): HandoffDesk {
  return { send: async () => outcome };
}

const ALLOWED: HandoffOutcome = {
  ok: true,
  to: "researcher",
  toName: "Researcher",
};

describe("the handoff tool", () => {
  test("is offered to a Bot that has somebody to ask", () => {
    const tool = handoffTool({
      desk: deskReturning(ALLOWED),
      from: FROM,
      hasSomebodyToAsk: true,
      maxDepth: 1,
      maxPerRun: 3,
    });

    expect(tool?.name).toBe(HANDOFF_TOOL);
  });

  test("is not offered to a Bot nobody granted", () => {
    expect(
      handoffTool({
        desk: deskReturning(ALLOWED),
        from: FROM,
        hasSomebodyToAsk: false,
        maxDepth: 1,
        maxPerRun: 3,
      }),
    ).toBe(null);
  });

  test("is not offered where the deployment has switched handoff off", () => {
    expect(
      handoffTool({
        desk: deskReturning(ALLOWED),
        from: FROM,
        hasSomebodyToAsk: true,
        maxDepth: 0,
        maxPerRun: 3,
      }),
    ).toBe(null);
  });

  /*
   * The desk would refuse it anyway. This is about what the model is shown: one at the cap reaches
   * for the tool, is told no, and often reports that failure to the person.
   */
  test("is not offered to a run already at the cap", () => {
    expect(
      handoffTool({
        desk: deskReturning(ALLOWED),
        from: { ...FROM, depth: 1 },
        hasSomebodyToAsk: true,
        maxDepth: 1,
      }),
    ).toBe(null);
  });

  test("tells the model not to answer on the other Bot's behalf", async () => {
    const tool = handoffTool({
      desk: deskReturning(ALLOWED),
      from: FROM,
      hasSomebodyToAsk: true,
      maxDepth: 1,
      maxPerRun: 3,
    });

    const said = await tool?.execute({
      bot: "Researcher",
      task: "find the outage window",
    });

    expect(said).toContain("Researcher");
    expect(said).toContain("do not answer on its behalf");
  });

  /* A throw would end the run with nothing said, which reads as the Bot ignoring the person. */
  test("hands a refusal back as something the Bot can say", async () => {
    const tool = handoffTool({
      desk: deskReturning({
        ok: false,
        refusal: "You have not been given that Bot.",
      }),
      from: FROM,
      hasSomebodyToAsk: true,
      maxDepth: 1,
    });

    await expect(tool?.execute({ bot: "payroll", task: "t" })).resolves.toBe(
      "You have not been given that Bot.",
    );
  });

  test("a call missing the task is answered rather than thrown", async () => {
    const tool = handoffTool({
      desk: deskReturning(ALLOWED),
      from: FROM,
      hasSomebodyToAsk: true,
      maxDepth: 1,
      maxPerRun: 3,
    });

    await expect(tool?.execute({ bot: "researcher" })).resolves.toContain(
      "say what you are asking it to do",
    );
  });
});

/**
 * The other zero.
 *
 * A run allowed to go no Bots deep and a run allowed to address no Bots are the same deployment
 * decision from two directions, and only one of them was closing the door. With a fan-out cap of
 * zero the tool was offered, every call was refused, and the model told the person it had tried and
 * failed — which reads as the deployment being broken rather than as it being switched off.
 */
describe("a deployment that allows no hops at all", () => {
  test("offers nothing when the fan-out cap is zero", () => {
    expect(
      handoffTool({
        desk: deskReturning(ALLOWED),
        from: FROM,
        hasSomebodyToAsk: true,
        maxDepth: 1,
        maxPerRun: 0,
      }),
    ).toBeNull();
  });
});

/**
 * The sentence and the marker, held together.
 *
 * The transcript decides whether to draw a hop or a boundary by reading the first words of this
 * result. With one declaration the two sides cannot disagree about the PHRASE; what they can still
 * disagree about is whether the sentence actually starts with it, which is what shipped once and
 * drew every accepted hop as Blocked.
 */
describe("what an accepted hop answers with", () => {
  test("starts with the marker the transcript matches on", async () => {
    const tool = handoffTool({
      desk: deskReturning(ALLOWED),
      from: FROM,
      hasSomebodyToAsk: true,
      maxDepth: 1,
      maxPerRun: 3,
    });

    const said = await tool?.execute({ bot: "researcher", task: "find it" });

    expect(typeof said).toBe("string");
    expect(said as string).toStartWith(HANDED_OVER);
  });
});
