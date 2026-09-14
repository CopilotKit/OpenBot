import { describe, expect, test } from "bun:test";
import {
  askTheirOwnPerson,
  ESCALATE_TOOL,
  escalationTool,
  PUT_TO,
} from "../src/agents/escalation";
import type { AuditEventInput } from "../src/audit";

/**
 * Asking a person, as a first-class answer.
 *
 * The property that matters is that a Bot which cannot settle something has a named way to stop that
 * is not "hand it to another Bot", and that taking it leaves a row saying so.
 */

const FROM = {
  botId: "assistant",
  actorId: "user-1",
  runId: "run-1",
  threadId: "thread-1",
  depth: 0,
};

function recorder() {
  const written: AuditEventInput[] = [];
  return {
    written,
    store: {
      insert: async (event: AuditEventInput) => {
        written.push(event);
      },
    } as never,
  };
}

describe("asking a person", () => {
  test("is offered to every run, granted anybody or not", () => {
    const tool = escalationTool({ from: FROM, route: askTheirOwnPerson });
    expect(tool.name).toBe(ESCALATE_TOOL);
  });

  test("names who was reached, so the Bot can say what it did", async () => {
    const tool = escalationTool({ from: FROM, route: askTheirOwnPerson });

    const said = await tool.execute({ question: "which account?" });

    expect(said).toContain("the person in this conversation");
  });

  /*
   * A routine's Bot stopping to ask is the case worth finding: nobody is in the conversation to
   * answer, so the row has to say the question was raised by a schedule rather than by a person.
   */
  test("the row says what started the run, not only whose authority it had", async () => {
    const { written, store } = recorder();
    const tool = escalationTool({
      from: { ...FROM, initiator: { kind: "routine", id: "routine_7" } },
      route: askTheirOwnPerson,
      auditStore: store,
    });

    await tool.execute({ question: "which account?" });

    expect(written[0]?.initiator).toEqual({ kind: "routine", id: "routine_7" });
  });

  test("a run that says nothing leaves the row filed as a person's", async () => {
    const { written, store } = recorder();
    const tool = escalationTool({
      from: FROM,
      route: askTheirOwnPerson,
      auditStore: store,
    });

    await tool.execute({ question: "which account?" });

    expect(written[0]?.initiator).toBe(undefined);
  });

  test("the question is on the record", async () => {
    const { written, store } = recorder();
    const tool = escalationTool({
      from: FROM,
      route: askTheirOwnPerson,
      auditStore: store,
    });

    await tool.execute({ question: "which account?", why: "two match" });

    expect(written[0]).toMatchObject({
      eventType: "agent.escalated",
      targetId: "assistant",
      actorUserId: "user-1",
    });
    expect(written[0]?.payload).toMatchObject({
      question: "which account?",
      why: "two match",
    });
  });

  /*
   * A route that reaches nobody is the row worth finding later: the Bot stopped, the person was
   * never asked, and without it nothing anywhere says so.
   */
  test("a question that reached nobody is recorded as one", async () => {
    const { written, store } = recorder();
    const tool = escalationTool({
      from: FROM,
      route: async () => ({ refusal: "The on-call rota is not configured." }),
      auditStore: store,
    });

    const said = await tool.execute({ question: "which account?" });

    expect(said).toBe("The on-call rota is not configured.");
    expect(written[0]?.eventType).toBe("agent.escalation_failed");
  });

  /*
   * Mid-run with a person waiting: a throw ends the run with nothing said, which reads as the Bot
   * ignoring them.
   */
  test("a call with nothing in it is refused as a sentence", async () => {
    const tool = escalationTool({ from: FROM, route: askTheirOwnPerson });

    const said = await tool.execute({});

    expect(said).toContain("say what you need");
  });

  /*
   * The same call, spelled the other way.
   *
   * A question field that is present and empty is a call with nothing in it too, and the refusal
   * above is the sentence written for it. `message_bot`, the tool this competes with for the same
   * decision, refuses a blank task and says so; this is the other half of that.
   */
  test.each([
    ["an empty question", ""],
    ["a question of spaces", "   "],
  ])("%s is refused as a sentence", async (_name, question) => {
    const tool = escalationTool({ from: FROM, route: askTheirOwnPerson });

    const said = await tool.execute({ question });

    expect(said).toContain("say what you need");
    expect(said).not.toContain(PUT_TO);
  });

  test("a blank question reaches nobody and leaves no row saying it did", async () => {
    const { written, store } = recorder();
    let reached = 0;
    const tool = escalationTool({
      from: FROM,
      route: async () => {
        reached += 1;
        return { reached: "the on-call engineer" };
      },
      auditStore: store,
    });

    await tool.execute({ question: "  " });

    // An `agent.escalated` row with no question in it is the row an operator counts escalations by,
    // saying a person was asked something that was never said.
    expect(reached).toBe(0);
    expect(written).toEqual([]);
  });

  test("a question with room around it is recorded as the question", async () => {
    const { written, store } = recorder();
    const tool = escalationTool({
      from: FROM,
      route: askTheirOwnPerson,
      auditStore: store,
    });

    await tool.execute({ question: "  which account?  " });

    expect(written[0]?.payload).toMatchObject({ question: "which account?" });
  });
});

/*
 * Same property, other tool: the transcript reads the first words of this to decide whether the
 * question reached anybody.
 */
describe("what a routed question answers with", () => {
  test("starts with the marker the transcript matches on", async () => {
    const tool = escalationTool({ from: FROM, route: askTheirOwnPerson });

    const said = await tool.execute({ question: "which account?" });

    expect(said as string).toStartWith(PUT_TO);
  });
});
