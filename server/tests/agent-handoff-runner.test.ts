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
  deliver?: (input: { work: HandoffWork; message: string }) => Promise<void>;
}) {
  const calls: Array<{ verb: string; key: string; owner?: string }> = [];
  const events: string[] = [];
  const delivered: Array<{ message: string; assertion: string }> = [];

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
    runner: createHandoffRunner({
      queue,
      owner: "replica-a",
      sign: (work) => `signed:${work.toBotId}:${work.depth}`,
      auditStore,
      delivery: {
        deliver: async ({ work, message, assertion }) => {
          delivered.push({ message, assertion });
          await options?.deliver?.({ work, message });
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
