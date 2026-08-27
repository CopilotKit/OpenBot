import { describe, expect, test } from "bun:test";
import {
  createHandoffRunner,
  type HandoffWork,
} from "../src/agents/handoff-runner";
import type { AuditStore } from "../src/audit";
import type { WorkItem, WorkQueue } from "../src/work/queue";

/**
 * Delivering a hop, and the three ways it must not go wrong.
 *
 * Running the other Bot twice for one hop. Finishing work that is no longer this replica's. And
 * letting a lease lapse in the middle of a run, which is the same as the first with extra steps.
 */

const WORK: HandoffWork = {
  fromBotId: "assistant",
  toBotId: "researcher",
  actorId: "user-1",
  threadId: "thread-1",
  runId: "run-1",
  depth: 1,
  task: "find the outage window",
  expecting: "a date range",
};

function runner(options?: {
  claimed?: WorkItem[];
  deliver?: (input: {
    work: HandoffWork;
    message: string;
    shown?: string;
  }) => Promise<void>;
}) {
  const calls: Array<{ verb: string; key: string; owner?: string }> = [];
  const events: string[] = [];
  const delivered: Array<{ message: string; assertion: string }> = [];
  const offered: HandoffWork[] = [];

  const queue = {
    claim: async () =>
      options?.claimed ?? [
        { kind: "bot.message", key: "run-1:abc", payload: WORK, attempts: 1 },
      ],
    renew: async () => true,
    finish: async ({ key, owner }: { key: string; owner: string }) => {
      calls.push({ verb: "finish", key, owner });
      return true;
    },
    release: async ({ key, owner }: { key: string; owner: string }) => {
      calls.push({ verb: "release", key, owner });
      return true;
    },
    offer: async ({
      key,
      payload,
    }: {
      key: string;
      payload?: Record<string, unknown>;
    }) => {
      calls.push({ verb: "offer", key });
      offered.push(payload as unknown as HandoffWork);
    },
  } as unknown as WorkQueue;

  const auditStore: AuditStore = {
    insert: async (event) => {
      events.push(event.eventType);
    },
  };

  return {
    calls,
    events,
    delivered,
    offered,
    runner: createHandoffRunner({
      queue,
      owner: "replica-a",
      sign: (work) => `signed:${work.toBotId}:${work.depth}`,
      auditStore,
      delivery: {
        deliver: async ({ work, message, shown, assertion }) => {
          delivered.push({ message, assertion });
          await options?.deliver?.({ work, message, shown });
        },
      },
    }),
  };
}

describe("delivering a hop", () => {
  test("runs the addressed Bot and finishes the work as its owner", async () => {
    const { runner: sweep, calls, delivered } = runner();

    const report = await sweep.sweep();

    expect(report.delivered).toEqual(["researcher"]);
    expect(calls).toEqual([
      { verb: "finish", key: "run-1:abc", owner: "replica-a" },
    ]);
    expect(delivered).toHaveLength(1);
  });

  /*
   * Who is asking is stamped by the deployment, from the row it wrote. A Bot able to write its own
   * attribution is a Bot able to claim to be another one.
   */
  test("the addressed Bot is told who asked, and what for, in parts", async () => {
    const { runner: sweep, delivered } = runner();

    await sweep.sweep();

    const message = delivered[0]?.message ?? "";
    expect(message).toContain("assistant");
    expect(message).toContain("Task: find the outage window");
    // The parts stay parts: the asking model was made to name them so this one need not infer them.
    expect(message).toContain("What a good answer looks like: a date range");
  });

  test("the run it starts carries the depth this hop reached", async () => {
    const { runner: sweep, delivered } = runner();

    await sweep.sweep();

    expect(delivered[0]?.assertion).toBe("signed:researcher:1");
  });

  /*
   * A Bot that answered has answered, whatever it said. Retrying a delivery because the answer was
   * unhelpful would ask it the same question again and bill for the same non-answer.
   */
  test("a delivery that fails is released rather than finished", async () => {
    const {
      runner: sweep,
      calls,
      events,
    } = runner({
      deliver: async () => {
        throw new Error("the gateway was unreachable");
      },
    });

    const report = await sweep.sweep();

    expect(report.delivered).toEqual([]);
    expect(calls).toEqual([
      { verb: "release", key: "run-1:abc", owner: "replica-a" },
    ]);
    expect(events).toContain("agent.handoff_failed");
  });

  /*
   * A second attempt may already have run that Bot, spent a model call and posted an answer before
   * its owner died. Somebody reading two similar answers should be able to tell which happened.
   */
  test("a second attempt says so, before it runs anything", async () => {
    const { runner: sweep, events } = runner({
      claimed: [
        { kind: "bot.message", key: "run-1:abc", payload: WORK, attempts: 2 },
      ],
    });

    await sweep.sweep();

    expect(events[0]).toBe("agent.handoff_retried");
    expect(events).toContain("agent.handoff_delivered");
  });

  /* Releasing an unusable row would put it back on the queue for ever. */
  test("a row that is not a hop is finished rather than released", async () => {
    const { runner: sweep, calls } = runner({
      claimed: [
        { kind: "bot.message", key: "run-1:junk", payload: {}, attempts: 1 },
      ],
    });

    const report = await sweep.sweep();

    expect(report.skipped).toEqual([
      { key: "run-1:junk", reason: "not a hop" },
    ]);
    expect(calls).toEqual([
      { verb: "finish", key: "run-1:junk", owner: "replica-a" },
    ]);
  });
});

/**
 * A hop that will not be tried again.
 *
 * The person was told their question had been handed on. If nothing ever comes back and nothing ever
 * says so, they cannot tell a slow Bot from a broken one, and the conversation simply stops.
 */
describe("a hop that failed for good", () => {
  test("the Bot that asked is sent back to tell the person", async () => {
    const { runner: sweeper, offered } = runner({
      claimed: [
        { kind: "bot.message", key: "run-1:abc", payload: WORK, attempts: 5 },
      ] as unknown as WorkItem[],
      deliver: async () => {
        throw new Error("researcher did not finish within 300s");
      },
    });

    await sweeper.sweep();

    expect(offered).toHaveLength(1);
    // Back to the Bot that asked, in the conversation the person is watching.
    expect(offered[0]).toMatchObject({
      fromBotId: "researcher",
      toBotId: "assistant",
      answerIn: "thread-1",
      threadId: "thread-1",
    });
    expect(offered[0]?.task).toContain("did not finish within 300s");
  });

  /*
   * The fan-out cap counts every row whose key starts with the run's own prefix. A notice is not one
   * of the Bots this run asked for, and a run long enough to see a hop fail for good is exactly the
   * run that still has asking to do.
   */
  test("its key is outside the run's own prefix, so it costs no fan-out budget", async () => {
    const {
      runner: sweeper,
      calls,
      offered,
    } = runner({
      claimed: [
        { kind: "bot.message", key: "run-1:abc", payload: WORK, attempts: 5 },
      ] as unknown as WorkItem[],
      deliver: async () => {
        throw new Error("nope");
      },
    });

    await sweeper.sweep();

    const key = calls.find((call) => call.verb === "offer")?.key ?? "";
    expect(key.startsWith("run-1:")).toBe(false);
    expect(key).toContain("run-1:abc");
    expect(offered).toHaveLength(1);
  });

  /*
   * One run may legally ask the same Bot two different things. Keyed on the Bot alone both notices
   * are the same work to `offer`, the second is dropped on conflict, and nothing purges this kind —
   * so the person hears about one of their two lost questions, for good.
   */
  test("two lost questions to one Bot leave two notices", async () => {
    const { runner: sweeper, calls } = runner({
      claimed: [
        { kind: "bot.message", key: "run-1:aaa", payload: WORK, attempts: 5 },
        { kind: "bot.message", key: "run-1:bbb", payload: WORK, attempts: 5 },
      ] as unknown as WorkItem[],
      deliver: async () => {
        throw new Error("nope");
      },
    });

    await sweeper.sweep();

    const keys = calls
      .filter((call) => call.verb === "offer")
      .map((call) => call.key);
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(2);
  });

  /*
   * Otherwise a Bot nobody can reach produces a notice that cannot be delivered either, which
   * produces a notice, for ever.
   */
  test("a notice that fails is not itself noticed", async () => {
    const { runner: sweeper, offered } = runner({
      claimed: [
        {
          kind: "bot.message",
          key: "run-1:notice:researcher",
          payload: { ...WORK, answerIn: "thread-1" },
          attempts: 5,
        },
      ] as unknown as WorkItem[],
      deliver: async () => {
        throw new Error("nope");
      },
    });

    await sweeper.sweep();

    expect(offered).toEqual([]);
  });

  test("a hop with tries left is simply released", async () => {
    const {
      runner: sweeper,
      offered,
      calls,
    } = runner({
      claimed: [
        { kind: "bot.message", key: "run-1:abc", payload: WORK, attempts: 2 },
      ] as unknown as WorkItem[],
      deliver: async () => {
        throw new Error("busy");
      },
    });

    await sweeper.sweep();

    expect(offered).toEqual([]);
    expect(calls.map((call) => call.verb)).toContain("release");
  });
});

/**
 * What a notice leaves in the transcript.
 *
 * Nothing. The asking Bot's own sentence is the whole message; the text that prompted it is an
 * instruction to a model, and kept it appears as something the person typed and had read back.
 */
describe("what a notice shows", () => {
  test("the instruction that produced it is not shown to anybody", async () => {
    const shownTexts: Array<string | undefined> = [];
    const { runner: sweeper } = runner({
      claimed: [
        {
          kind: "bot.message",
          key: "run-1:notice:researcher",
          payload: { ...WORK, answerIn: "thread-1" },
          attempts: 1,
        },
      ] as unknown as WorkItem[],
      deliver: async (input) => {
        shownTexts.push(input.shown);
      },
    });

    await sweeper.sweep();

    expect(shownTexts).toEqual([undefined]);
  });

  test("an ordinary hop shows who asked and what for", async () => {
    const shownTexts: Array<string | undefined> = [];
    const { runner: sweeper } = runner({
      claimed: [
        {
          kind: "bot.message",
          key: "run-1:abc",
          payload: { ...WORK, fromName: "Assistant", toName: "Researcher" },
          attempts: 1,
        },
      ] as unknown as WorkItem[],
      deliver: async (input) => {
        shownTexts.push(input.shown);
      },
    });

    await sweeper.sweep();

    expect(shownTexts[0]).toBe(
      "Assistant asked Researcher for this on your behalf: find the outage window",
    );
  });
});
