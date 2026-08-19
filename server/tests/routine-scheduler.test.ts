import { describe, expect, test } from "bun:test";
import type { RoutineRunner } from "../src/routines/runner";
import { createScheduler } from "../src/routines/scheduler";
import type {
  DueCandidate,
  RoutineRunRecord,
  RoutineStore,
} from "../src/routines/store";

/**
 * What the tick has to get right, with the clock as an argument.
 *
 * The store is faked, but the ONE thing it does not fake is the claim: `startRun` here refuses a
 * second live run exactly as the unique index does, because every property below depends on that
 * being the shape the scheduler is written against. A scheduler that assumed claims always succeed
 * would pass a test with a permissive fake and start two runs in production.
 *
 * Errors are the other half. A routine whose Bot cannot be resolved, a run that throws, a database
 * blip: none of them may stop the loop, because an unhandled rejection inside an interval takes the
 * whole deployment's schedule down for the life of the process.
 */

const weekdaysAtEight = {
  type: "daily" as const,
  time: "08:00",
  weekdays: [1, 2, 3, 4, 5],
};

/** Thursday. See routine-schedule.test.ts, which owns the weekday arithmetic. */
const EIGHT = new Date("2026-08-13T08:00:20.000Z");
const NOON = new Date("2026-08-13T12:00:00.000Z");

function fakeStore(candidates: DueCandidate[]) {
  const started: { routineId: string; trigger: string }[] = [];
  const finished: { runId: string; status: string; error?: string }[] = [];
  const missed: { routineId: string; dueAt: Date }[] = [];
  /** Which routines currently hold a live run, which is what the unique index really enforces. */
  const live = new Set<string>();
  let runNumber = 0;

  const store = {
    dueCandidates: async () => candidates,
    candidate: async (id: string) =>
      candidates.find((entry) => entry.id === id) ?? null,
    startRun: async (input: { routineId: string; trigger: string }) => {
      if (live.has(input.routineId)) return null;
      live.add(input.routineId);
      runNumber += 1;
      started.push({ routineId: input.routineId, trigger: input.trigger });
      return { id: `run-${runNumber}` } as RoutineRunRecord;
    },
    finishRun: async (input: {
      runId: string;
      routineId: string;
      status: string;
      error?: string;
    }) => {
      live.delete(input.routineId);
      finished.push({
        runId: input.runId,
        status: input.status,
        ...(input.error ? { error: input.error } : {}),
      });
    },
    recordMissed: async (input: { routineId: string; dueAt: Date }) => {
      missed.push({ routineId: input.routineId, dueAt: input.dueAt });
    },
  } as unknown as RoutineStore;

  return { store, started, finished, missed, live };
}

const routine = (overrides: Partial<DueCandidate> = {}): DueCandidate => ({
  id: "routine-1",
  agentId: "risk-analyst",
  ownerUserId: "someone",
  name: "Overnight alerts",
  prompt: "Check the overnight alerts.",
  schedule: weekdaysAtEight,
  lastRunAt: null,
  activeRun: false,
  ...overrides,
});

/** A runner whose completion the test decides, so an in-flight run can actually be in flight. */
function heldRunner() {
  let release: (() => void) | undefined;
  const runner: RoutineRunner = {
    run: () =>
      new Promise((resolve) => {
        release = () =>
          resolve({ summary: "Done.", turns: 1, stoppedAtCap: false });
      }),
  };
  return { runner, release: () => release?.() };
}

/** Let the fire-and-forget run settle. The tick deliberately does not await it; see scheduler.ts. */
const settle = async () => {
  for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
};

describe("the tick", () => {
  test("starts a run when the window has just opened", async () => {
    const { store, started } = fakeStore([routine()]);
    const scheduler = createScheduler({
      store,
      runner: {
        run: async () => ({ summary: "Done.", turns: 1, stoppedAtCap: false }),
      },
      threadIdFor: (id) => `thread-${id}`,
    });

    await scheduler.tick(EIGHT);
    await settle();

    expect(started).toEqual([{ routineId: "routine-1", trigger: "schedule" }]);
  });

  test("records a window nobody was awake for rather than running it four hours late", async () => {
    const { store, started, missed } = fakeStore([routine()]);
    const scheduler = createScheduler({
      store,
      runner: {
        run: async () => ({ summary: "", turns: 1, stoppedAtCap: false }),
      },
      threadIdFor: (id) => `thread-${id}`,
    });

    await scheduler.tick(NOON);
    await settle();

    expect(started).toEqual([]);
    expect(missed).toEqual([
      { routineId: "routine-1", dueAt: new Date("2026-08-13T08:00:00.000Z") },
    ]);
  });

  /*
   * A run that takes longer than a minute is ordinary, and the tick that lands while it is going
   * must not start a second. Two emails sent is the failure this prevents.
   */
  test("does not start a second run while one is still going", async () => {
    const held = heldRunner();
    const { store, started } = fakeStore([routine()]);
    const scheduler = createScheduler({
      store,
      runner: held.runner,
      threadIdFor: (id) => `thread-${id}`,
    });

    await scheduler.tick(EIGHT);
    await settle();
    await scheduler.tick(new Date("2026-08-13T08:01:20.000Z"));
    await settle();

    expect(started).toHaveLength(1);
    held.release();
    await settle();
  });

  test("a routine the store already reports as running is skipped before the claim", async () => {
    const { store, started } = fakeStore([routine({ activeRun: true })]);
    const scheduler = createScheduler({
      store,
      runner: {
        run: async () => ({ summary: "", turns: 1, stoppedAtCap: false }),
      },
      threadIdFor: (id) => `thread-${id}`,
    });

    await scheduler.tick(EIGHT);
    await settle();
    expect(started).toEqual([]);
  });

  /*
   * A schedule nothing can read is left alone rather than guessed at. The routine stays visible so
   * its owner can fix or delete it, and nothing fires meanwhile.
   */
  test("a routine with an unreadable schedule is skipped, loudly and without firing", async () => {
    const logged: Record<string, unknown>[] = [];
    const { store, started, missed } = fakeStore([routine({ schedule: null })]);
    const scheduler = createScheduler({
      store,
      runner: {
        run: async () => ({ summary: "", turns: 1, stoppedAtCap: false }),
      },
      threadIdFor: (id) => `thread-${id}`,
      log: (entry) => logged.push(entry),
    });

    await scheduler.tick(EIGHT);
    await settle();

    expect(started).toEqual([]);
    expect(missed).toEqual([]);
    expect(logged[0]?.type).toBe("routine-schedule-unreadable");
  });

  test("a run that throws is recorded as failed rather than left running forever", async () => {
    const logged: Record<string, unknown>[] = [];
    const { store, finished, live } = fakeStore([routine()]);
    const scheduler = createScheduler({
      store,
      runner: {
        run: async () => {
          throw new Error("that Bot has been deleted");
        },
      },
      threadIdFor: (id) => `thread-${id}`,
      log: (entry) => logged.push(entry),
    });

    await scheduler.tick(EIGHT);
    await settle();

    expect(finished).toEqual([
      { runId: "run-1", status: "failed", error: "that Bot has been deleted" },
    ]);
    // A run stuck in `running` holds the one-at-a-time claim and the routine never fires again, so
    // writing the failure matters even when it is the second thing to have gone wrong.
    expect(live.size).toBe(0);
    expect(logged[0]?.type).toBe("routine-run-failed");
  });

  /*
   * A person deleting a routine has asked for it to be gone. The finishing write finds nothing, and
   * that must not become an unhandled rejection that takes the schedule down with it.
   */
  test("survives the routine being deleted while its run is in flight", async () => {
    const logged: Record<string, unknown>[] = [];
    const { store } = fakeStore([routine()]);
    const deleting = {
      ...store,
      finishRun: async () => {
        throw new Error("the routine no longer exists");
      },
    } as unknown as RoutineStore;
    const scheduler = createScheduler({
      store: deleting,
      runner: {
        run: async () => {
          throw new Error("the routine no longer exists");
        },
      },
      threadIdFor: (id) => `thread-${id}`,
      log: (entry) => logged.push(entry),
    });

    await scheduler.tick(EIGHT);
    await settle();

    expect(logged.map((entry) => entry.type)).toContain(
      "routine-run-not-recorded",
    );
  });

  test("a store that cannot be reached ends the pass, not the loop", async () => {
    const logged: Record<string, unknown>[] = [];
    const scheduler = createScheduler({
      store: {
        dueCandidates: async () => {
          throw new Error("the database is unreachable");
        },
      } as unknown as RoutineStore,
      runner: {
        run: async () => ({ summary: "", turns: 1, stoppedAtCap: false }),
      },
      threadIdFor: (id) => `thread-${id}`,
      log: (entry) => logged.push(entry),
    });

    // No rejection reaches the caller: an interval that rejects takes the whole schedule with it.
    await scheduler.tick(EIGHT);
    expect(logged[0]?.type).toBe("routine-tick-failed");

    // And the next pass still works, which is the property that matters.
    await scheduler.tick(EIGHT);
    expect(logged).toHaveLength(2);
  });
});

describe("running one on somebody's say-so", () => {
  test("records the trigger as manual, not as the clock", async () => {
    const { store, started } = fakeStore([routine()]);
    const scheduler = createScheduler({
      store,
      runner: {
        run: async () => ({ summary: "Done.", turns: 1, stoppedAtCap: false }),
      },
      threadIdFor: (id) => `thread-${id}`,
    });

    expect(await scheduler.runNow("routine-1", { id: "someone" })).toBe(
      "started",
    );
    await settle();
    expect(started).toEqual([{ routineId: "routine-1", trigger: "manual" }]);
  });

  test("says busy rather than starting a second run", async () => {
    const held = heldRunner();
    const { store } = fakeStore([routine()]);
    const scheduler = createScheduler({
      store,
      runner: held.runner,
      threadIdFor: (id) => `thread-${id}`,
    });

    expect(await scheduler.runNow("routine-1", { id: "someone" })).toBe(
      "started",
    );
    await settle();
    // Pressing the button twice is ordinary, and is not an error. It is also not two runs.
    expect(await scheduler.runNow("routine-1", { id: "someone" })).toBe("busy");

    held.release();
    await settle();
  });

  test("says so when the routine has gone", async () => {
    const { store } = fakeStore([]);
    const scheduler = createScheduler({
      store,
      runner: {
        run: async () => ({ summary: "", turns: 1, stoppedAtCap: false }),
      },
      threadIdFor: (id) => `thread-${id}`,
    });

    expect(await scheduler.runNow("routine-9", { id: "someone" })).toBe(
      "unknown",
    );
  });
});

describe("running what a delivery asked for", () => {
  test("puts the delivery underneath the routine's own prompt", async () => {
    let seen = "";
    const { store, started } = fakeStore([routine()]);
    const scheduler = createScheduler({
      store,
      runner: {
        run: async (request) => {
          seen = request.prompt;
          return { summary: "Done.", turns: 1, stoppedAtCap: false };
        },
      },
      threadIdFor: (id) => `thread-${id}`,
    });

    const started_ = await scheduler.runFromWebhook({
      triggerId: "trigger-1",
      routineId: "routine-1",
      agentId: null,
      prompt: null,
      ownerUserId: "someone",
      body: { branch: "main" },
      eventType: "build.finished",
    });
    await settle();

    expect(started_).toBe(true);
    expect(started).toEqual([{ routineId: "routine-1", trigger: "webhook" }]);
    expect(seen.startsWith("Check the overnight alerts.")).toBe(true);
    expect(seen).toContain("build.finished");
    expect(seen).toContain('"branch": "main"');
  });

  test("a trigger carrying its own prompt runs it without a routine", async () => {
    let seen = "";
    const { store, started } = fakeStore([]);
    const scheduler = createScheduler({
      store,
      runner: {
        run: async (request) => {
          seen = request.prompt;
          return { summary: "Done.", turns: 1, stoppedAtCap: false };
        },
      },
      threadIdFor: (id) => `thread-${id}`,
    });

    expect(
      await scheduler.runFromWebhook({
        triggerId: "trigger-1",
        routineId: null,
        agentId: "risk-analyst",
        prompt: "Tell me what broke.",
        ownerUserId: "someone",
        body: { branch: "main" },
        eventType: null,
      }),
    ).toBe(true);
    await settle();

    // No routine, so no run row: these deliveries live in the audit trail rather than in the run
    // history. Stated here as much as in the code, because it is the cost of the shape.
    expect(started).toEqual([]);
    expect(seen.startsWith("Tell me what broke.")).toBe(true);
  });

  test("a delivery for a routine that has gone starts nothing", async () => {
    const { store } = fakeStore([]);
    const scheduler = createScheduler({
      store,
      runner: {
        run: async () => ({ summary: "", turns: 1, stoppedAtCap: false }),
      },
      threadIdFor: (id) => `thread-${id}`,
    });

    expect(
      await scheduler.runFromWebhook({
        triggerId: "trigger-1",
        routineId: "routine-9",
        agentId: null,
        prompt: null,
        ownerUserId: "someone",
        body: {},
        eventType: null,
      }),
    ).toBe(false);
  });
});
