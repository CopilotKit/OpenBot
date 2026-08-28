import { describe, expect, test } from "bun:test";
import type { AgentActor } from "../src/agents/profile-types";
import type {
  AgentChannel,
  ChannelActivity,
  ChannelStore,
} from "../src/channels/routes";
import { createRoutineRunner, type TurnRunner } from "../src/routines/runner";
import type {
  RoutineRunContext,
  RoutineRunOutcome,
  RoutineStore,
} from "../src/routines/store";

/**
 * A routine's turn with nobody's browser open, asserted without a database and without a model.
 *
 * The runner is the one place a headless firing does what a browser normally does — record the
 * reply as channel activity — so what is under test is the sequence and the counts: exactly one
 * activity per successful turn, exactly one run row closed, and the fatigue rule speaking once and
 * then shutting up. `runTurn` is injected, which is why nothing here dials a model, and the store
 * halves are recording stubs, which is why nothing here needs Postgres.
 *
 * The person-facing half of RoutineStore throws on contact: the runner acts as the owner but is not
 * the owner asking a question, and reaching for `create` or `listFor` from here would be a bug that
 * a test asserting only outcomes would not see.
 */

const OWNER: AgentActor = { id: "user_owner", role: "user" };

const CONTEXT: RoutineRunContext = {
  routineId: "routine_1",
  ownerUserId: "user_owner",
  agentId: "bot_helper",
  channelId: "channel_1",
  instruction: "Post the standup summary.",
};

const CHANNEL: AgentChannel = {
  id: "channel_1",
  name: "Standup",
  agentIds: ["bot_helper"],
  threadId: "thread_owner_channel_1",
  active: true,
};

const RUN_ID = "routine_run_1";

type Recorded = {
  finished: { runId: string; status: RoutineRunOutcome; error?: string }[];
  activity: {
    actor: AgentActor;
    channelId: string;
    activity: ChannelActivity;
  }[];
  enabled: { ownerUserId: string; id: string; enabled: boolean }[];
  turns: Parameters<TurnRunner>[0][];
};

function unreachable(method: string): never {
  throw new Error(`the runner must not call ${method}`);
}

function harness(options: {
  context?: RoutineRunContext | null;
  channel?: AgentChannel | null;
  failures?: number;
  runTurn?: TurnRunner;
  recordActivity?: () => Promise<void>;
}) {
  const recorded: Recorded = {
    finished: [],
    activity: [],
    enabled: [],
    turns: [],
  };

  const routineStore: RoutineStore = {
    create: () => unreachable("create"),
    listFor: () => unreachable("listFor"),
    update: () => unreachable("update"),
    remove: () => unreachable("remove"),
    dueRoutines: () => unreachable("dueRoutines"),
    advanceNextRun: () => unreachable("advanceNextRun"),
    insertRun: () => unreachable("insertRun"),

    async runContext(runId) {
      expect(runId).toBe(RUN_ID);
      return options.context === undefined ? CONTEXT : options.context;
    },
    async finishRun(runId, status, error) {
      recorded.finished.push({ runId, status, error });
    },
    async consecutiveFailures(routineId) {
      expect(routineId).toBe(CONTEXT.routineId);
      // Read AFTER the failure is on the row, or the tenth failure reads as the ninth: hoisting
      // this read above `finishRun` in the runner would keep every other assertion here green.
      expect(recorded.finished).toHaveLength(1);
      expect(recorded.finished[0]).toMatchObject({
        runId: RUN_ID,
        status: "failed",
      });
      return options.failures ?? 0;
    },
    async setEnabled(ownerUserId, id, enabled) {
      recorded.enabled.push({ ownerUserId, id, enabled });
    },
  };

  const channelStore: ChannelStore = {
    create: () => unreachable("channels.create"),
    list: () => unreachable("channels.list"),
    setPinned: () => unreachable("channels.setPinned"),
    markRead: () => unreachable("channels.markRead"),
    softDelete: () => unreachable("channels.softDelete"),

    async get(actor, channelId) {
      expect(actor).toEqual(OWNER);
      expect(channelId).toBe(CONTEXT.channelId);
      return options.channel === undefined ? CHANNEL : options.channel;
    },
    async recordActivity(actor, channelId, activity) {
      recorded.activity.push({ actor, channelId, activity });
      if (options.recordActivity) await options.recordActivity();
    },
  };

  const runTurn: TurnRunner = async (input) => {
    recorded.turns.push(input);
    if (options.runTurn) return await options.runTurn(input);
    return { replyText: "Three people are blocked." };
  };

  return {
    recorded,
    runner: createRoutineRunner({ routineStore, channelStore, runTurn }),
  };
}

const throwingTurn: TurnRunner = async () => {
  throw new Error("the model refused");
};

describe("createRoutineRunner", () => {
  test("runs the owner's thread and records the reply exactly once", async () => {
    const { runner, recorded } = harness({});

    await runner.run(RUN_ID);

    expect(recorded.turns).toEqual([
      {
        ownerUserId: CONTEXT.ownerUserId,
        agentId: CONTEXT.agentId,
        threadId: CHANNEL.threadId,
        instruction: CONTEXT.instruction,
      },
    ]);
    // The count, not merely that one happened: a second record would ring a second unread dot.
    expect(recorded.activity).toHaveLength(1);
    expect(recorded.activity[0]?.actor).toEqual(OWNER);
    expect(recorded.activity[0]?.channelId).toBe(CONTEXT.channelId);
    expect(recorded.activity[0]?.activity.text).toBe(
      "Three people are blocked.",
    );
    expect(recorded.activity[0]?.activity.agentId).toBe(CONTEXT.agentId);
    expect(recorded.finished).toEqual([
      { runId: RUN_ID, status: "succeeded", error: undefined },
    ]);
    expect(recorded.enabled).toEqual([]);
  });

  test("records a thrown turn as a failure carrying its message", async () => {
    const { runner, recorded } = harness({
      runTurn: throwingTurn,
      failures: 1,
    });

    await runner.run(RUN_ID);

    expect(recorded.finished).toEqual([
      { runId: RUN_ID, status: "failed", error: "the model refused" },
    ]);
  });

  test("says so once on the first failure after a success", async () => {
    const { runner, recorded } = harness({
      runTurn: throwingTurn,
      failures: 1,
    });

    await runner.run(RUN_ID);

    expect(recorded.activity).toHaveLength(1);
    expect(recorded.activity[0]?.activity.text).toBe(
      "This routine failed: the model refused",
    );
    expect(recorded.activity[0]?.activity.agentId).toBe(CONTEXT.agentId);
    expect(recorded.enabled).toEqual([]);
  });

  test("says nothing on the second consecutive failure", async () => {
    const { runner, recorded } = harness({
      runTurn: throwingTurn,
      failures: 2,
    });

    await runner.run(RUN_ID);

    expect(recorded.activity).toEqual([]);
    expect(recorded.enabled).toEqual([]);
    expect(recorded.finished).toHaveLength(1);
  });

  test("switches the routine off after ten consecutive failures", async () => {
    const { runner, recorded } = harness({
      runTurn: throwingTurn,
      failures: 10,
    });

    await runner.run(RUN_ID);

    expect(recorded.enabled).toEqual([
      {
        ownerUserId: CONTEXT.ownerUserId,
        id: CONTEXT.routineId,
        enabled: false,
      },
    ]);
    expect(recorded.activity).toHaveLength(1);
    expect(recorded.activity[0]?.activity.text).toBe(
      "This routine has failed ten times in a row, so I have switched it off. Ask me to turn it back on when whatever it needs is working.",
    );
  });

  test("skips a firing whose channel is gone without running a turn", async () => {
    const { runner, recorded } = harness({ channel: null });

    await runner.run(RUN_ID);

    expect(recorded.turns).toEqual([]);
    expect(recorded.activity).toEqual([]);
    expect(recorded.finished).toEqual([
      { runId: RUN_ID, status: "skipped", error: "the channel is gone" },
    ]);
  });

  test("does nothing at all for a run row that is gone", async () => {
    const { runner, recorded } = harness({ context: null });

    await runner.run(RUN_ID);

    expect(recorded).toEqual({
      finished: [],
      activity: [],
      enabled: [],
      turns: [],
    });
  });

  test("keeps a succeeded run recorded when the channel cannot be written to", async () => {
    const { runner, recorded } = harness({
      recordActivity: async () => {
        throw new Error("that channel is gone");
      },
    });

    await runner.run(RUN_ID);

    expect(recorded.finished).toEqual([
      { runId: RUN_ID, status: "succeeded", error: undefined },
    ]);
  });

  test("keeps a failed run recorded when the notification cannot be posted", async () => {
    const { runner, recorded } = harness({
      runTurn: throwingTurn,
      failures: 1,
      recordActivity: async () => {
        throw new Error("that channel is gone");
      },
    });

    await runner.run(RUN_ID);

    expect(recorded.finished).toEqual([
      { runId: RUN_ID, status: "failed", error: "the model refused" },
    ]);
  });

  test("truncates a failure reason at the code-point cap without splitting an emoji", async () => {
    // 170 code points: an ASCII run long enough to push the cut (at code point 159) into the
    // middle of the run of astral emoji that follows, so the cut has to land between code points,
    // never inside one of their surrogate pairs.
    const longReason = `${"a".repeat(150)}${"\u{1F600}".repeat(20)}`;
    const { runner, recorded } = harness({
      runTurn: async () => {
        throw new Error(longReason);
      },
      failures: 1,
    });

    await runner.run(RUN_ID);

    expect(recorded.activity).toHaveLength(1);
    const posted = recorded.activity[0]?.activity.text ?? "";
    expect(posted.startsWith("This routine failed: ")).toBe(true);
    const reasonPart = posted.slice("This routine failed: ".length);

    // Capped at MAX_NOTIFIED_REASON (160) code points: 159 kept, plus the implementation's own
    // ellipsis character — read runner.ts's `shorten` rather than assume a format here.
    expect(Array.from(reasonPart)).toHaveLength(160);
    expect(reasonPart).toBe(`${"a".repeat(150)}${"\u{1F600}".repeat(9)}…`);

    // The cut is measured in code points, not UTF-16 units, so no emoji is split into a lone
    // surrogate: the string stays well-formed and a code-point split round-trips cleanly.
    expect(reasonPart.isWellFormed()).toBe(true);
    expect(Array.from(reasonPart).join("")).toBe(reasonPart);
  });

  test("posts a thrown non-Error value with String(error)", async () => {
    const { runner, recorded } = harness({
      runTurn: async () => {
        throw "not an Error object";
      },
      failures: 1,
    });

    await runner.run(RUN_ID);

    expect(recorded.finished).toEqual([
      { runId: RUN_ID, status: "failed", error: "not an Error object" },
    ]);
    expect(recorded.activity).toHaveLength(1);
    expect(recorded.activity[0]?.activity.text).toBe(
      "This routine failed: not an Error object",
    );
  });
});
