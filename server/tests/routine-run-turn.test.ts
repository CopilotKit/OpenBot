import { AbstractAgent, EventType } from "@ag-ui/client";
import { describe, expect, test } from "bun:test";
import { EMPTY } from "rxjs";
import { createTurnRunner } from "../src/routines/run-turn";

/**
 * A headless turn, asserted without a gateway, without a database and without a model.
 *
 * This file exists because `run-turn.ts` RESTATES BY HAND five `ɵ`-prefixed request shapes that
 * `@copilotkit/runtime` does not export. Nothing else in the repository can catch a lock that is
 * acquired and never released, a renew that keeps a different lock alive than the one the cleanup
 * releases, or a `persistedInputMessages` that quietly re-persists a whole transcript — and every one
 * of those is felt by a person rather than by a test: a leaked lock refuses their next browser message
 * with 409 for the whole TTL, so a routine that fails at three in the morning locks them out of their
 * own conversation.
 *
 * So the properties here are the lifecycle ones: cleanup exactly once on every exit path, one run id
 * everywhere, the subtraction, and the order the three platform calls happen in.
 */

const OWNER = "user_owner";
const AGENT_ID = "bot_helper";
const THREAD_ID = "thread_owner_channel_1";
const INSTRUCTION = "Post the standup summary.";

type HistoryRow = {
  id: string;
  role: string;
  content?: unknown;
  activityType?: string;
  toolCalls?: { id: string; name: string; args: string }[];
  toolCallId?: string;
};

/** A `PlatformRequestError` as `isMissingThread` matches it: the name and the status, nothing else. */
function threadNotFound(): Error {
  const error = new Error("THREAD_NOT_FOUND");
  error.name = "PlatformRequestError";
  (error as Error & { status?: number }).status = 404;
  return error;
}

class FakeAgent extends AbstractAgent {
  aborts = 0;
  /** Set by a driver that wants the run to end when the turn is stopped. */
  onAbort?: () => void;

  run() {
    return EMPTY;
  }

  override abortRun(): void {
    this.aborts += 1;
    this.onAbort?.();
    super.abortRun();
  }
}

type Observer = {
  next: (event: { type: string; message?: string }) => void;
  error: (error: unknown) => void;
  complete: () => void;
};

type Driver = (context: {
  agent: FakeAgent;
  observer: Observer;
  request: { input: { runId: string; threadId: string } };
}) => void;

/** The default: the Bot answers, the way the runner leaves the answer on the agent it was passed. */
const answers: Driver = ({ agent, observer }) => {
  agent.messages = [
    ...agent.messages,
    { id: "assistant_1", role: "assistant", content: "Three things happened." },
  ] as typeof agent.messages;
  observer.complete();
};

function harness(options: {
  history?: HistoryRow[];
  historyFails?: () => Error;
  drive?: Driver;
  /**
   * What a renew does. A thunk that THROWS rather than one that returns a rejected promise: a
   * pre-rejected promise handed back through the async fake below is briefly handler-less while the
   * async function adopts it, which the test runner reports as an uncaught error even though the
   * code under test catches it.
   */
  renew?: () => unknown;
  turnTimeoutMs?: number;
  abortGraceMs?: number;
  heartbeatMs?: number;
  lockTtlSeconds?: number;
}) {
  const order: string[] = [];
  const calls = {
    threads: [] as { threadId: string; userId: string; agentId: string }[],
    acquired: [] as {
      threadId: string;
      runId: string;
      userId: string;
      agentId: string;
      ttlSeconds?: number;
    }[],
    renewed: [] as { threadId: string; runId: string; ttlSeconds: number }[],
    cleaned: [] as { threadId: string; runId: string }[],
    runs: [] as {
      threadId: string;
      input: { runId: string; messages: { id: string }[] };
      persistedInputMessages?: { id: string; content?: unknown }[];
    }[],
    stops: [] as { threadId: string; runId?: string }[],
  };

  const agent = new FakeAgent({ agentId: AGENT_ID });
  const drive = options.drive ?? answers;

  const intelligence = {
    getOrCreateThread: async (params: {
      threadId: string;
      userId: string;
      agentId: string;
    }) => {
      order.push("getOrCreateThread");
      calls.threads.push(params);
      return { thread: { id: params.threadId }, created: false };
    },
    getThreadMessages: async () => {
      order.push("getThreadMessages");
      if (options.historyFails) throw options.historyFails();
      return { messages: options.history ?? [] };
    },
    ɵacquireThreadLock: async (params: {
      threadId: string;
      runId: string;
      userId: string;
      agentId: string;
      ttlSeconds?: number;
    }) => {
      order.push("acquire");
      calls.acquired.push(params);
      return { threadId: params.threadId, runId: params.runId, joinToken: "t" };
    },
    ɵrenewThreadLock: async (params: {
      threadId: string;
      runId: string;
      ttlSeconds: number;
    }) => {
      calls.renewed.push(params);
      if (options.renew) return options.renew();
      return { ttlSeconds: params.ttlSeconds };
    },
    ɵcleanupThreadLock: async (params: { threadId: string; runId: string }) => {
      order.push("cleanup");
      calls.cleaned.push(params);
    },
  };

  const runner = {
    run: (request: {
      threadId: string;
      agent: unknown;
      input: { runId: string; threadId: string; messages: { id: string }[] };
      persistedInputMessages?: { id: string; content?: unknown }[];
    }) => {
      order.push("run");
      calls.runs.push(request);
      return {
        subscribe(observer: Observer) {
          drive({ agent: request.agent as FakeAgent, observer, request });
          return { unsubscribe: () => undefined };
        },
      };
    },
    stop: async (request: { threadId: string; runId?: string }) => {
      order.push("stop");
      calls.stops.push(request);
      return true;
    },
  };

  const runTurn = createTurnRunner({
    // biome-ignore lint/suspicious/noExplicitAny: narrow structural fakes, on purpose.
    intelligence: intelligence as any,
    // biome-ignore lint/suspicious/noExplicitAny: narrow structural fakes, on purpose.
    runner: runner as any,
    buildAgentFor: async () => agent,
    ...(options.turnTimeoutMs === undefined
      ? {}
      : { turnTimeoutMs: options.turnTimeoutMs }),
    ...(options.abortGraceMs === undefined
      ? {}
      : { abortGraceMs: options.abortGraceMs }),
    ...(options.heartbeatMs === undefined
      ? {}
      : { heartbeatMs: options.heartbeatMs }),
    ...(options.lockTtlSeconds === undefined
      ? {}
      : { lockTtlSeconds: options.lockTtlSeconds }),
  });

  const run = () =>
    runTurn({
      ownerUserId: OWNER,
      agentId: AGENT_ID,
      threadId: THREAD_ID,
      instruction: INSTRUCTION,
    });

  return { run, agent, calls, order };
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const THREE_ROWS: HistoryRow[] = [
  { id: "m1", role: "user", content: "Hello." },
  { id: "m2", role: "assistant", content: "Hello back." },
  { id: "m3", role: "user", content: "Again." },
];

describe("a routine's headless turn", () => {
  test("creates the thread, takes the lock, then runs — in that order", async () => {
    const { run, order, calls } = harness({});

    await run();

    expect(order.indexOf("getOrCreateThread")).toBeLessThan(
      order.indexOf("acquire"),
    );
    expect(order.indexOf("acquire")).toBeLessThan(order.indexOf("run"));
    expect(calls.threads).toEqual([
      { threadId: THREAD_ID, userId: OWNER, agentId: AGENT_ID },
    ]);
  });

  test("returns what the Bot said, taken from the agent the runner was handed", async () => {
    const { run } = harness({});

    expect(await run()).toEqual({ replyText: "Three things happened." });
  });

  test("seeds the thread's history and the turn onto the agent", async () => {
    const { run, agent } = harness({
      history: [
        ...THREE_ROWS,
        {
          id: "m4",
          role: "assistant",
          toolCalls: [{ id: "call_1", name: "search", args: '{"q":"x"}' }],
        },
      ],
    });

    await run();

    expect(agent.threadId).toBe(THREAD_ID);
    // The four history rows, then this turn's instruction, then what the run added.
    expect(agent.messages.map((message) => message.id).slice(0, 4)).toEqual([
      "m1",
      "m2",
      "m3",
      "m4",
    ]);
    // A tool-call-only row has no content on the platform, and AG-UI requires the field.
    expect(agent.messages[3]).toMatchObject({
      content: "",
      toolCalls: [
        {
          id: "call_1",
          type: "function",
          function: { name: "search", arguments: '{"q":"x"}' },
        },
      ],
    });
    expect(agent.messages[4]).toMatchObject({
      role: "user",
      content: INSTRUCTION,
    });
  });

  test("a thread the platform has never heard of reads as no history", async () => {
    const { run, calls } = harness({ historyFails: threadNotFound });

    await run();

    expect(calls.runs[0]?.input.messages).toHaveLength(1);
  });
});

describe("persistedInputMessages is the subtraction", () => {
  test("a history of three plus one new message persists exactly the new one", async () => {
    const { run, calls } = harness({ history: THREE_ROWS });

    await run();

    const [request] = calls.runs;
    expect(request?.input.messages).toHaveLength(4);
    expect(request?.persistedInputMessages).toHaveLength(1);
    expect(request?.persistedInputMessages?.[0]?.content).toBe(INSTRUCTION);
    // Identified by id, not by position: none of the history's ids may appear.
    const historic = new Set(THREE_ROWS.map((row) => row.id));
    for (const message of request?.persistedInputMessages ?? []) {
      expect(historic.has(message.id)).toBe(false);
    }
  });

  test("an empty history persists everything", async () => {
    const { run, calls } = harness({ history: [] });

    await run();

    const [request] = calls.runs;
    expect(request?.persistedInputMessages).toHaveLength(1);
    expect(request?.persistedInputMessages?.length).toBe(
      request?.input.messages.length,
    );
  });
});

describe("the lock is released on every exit path", () => {
  test("on success", async () => {
    const { run, calls } = harness({});

    await run();

    expect(calls.cleaned).toEqual([
      { threadId: THREAD_ID, runId: calls.acquired[0]?.runId ?? "" },
    ]);
  });

  test("when the run rejects", async () => {
    const { run, calls } = harness({
      drive: ({ observer }) => observer.error(new Error("the socket died")),
    });

    await expect(run()).rejects.toThrow("the socket died");

    expect(calls.cleaned).toEqual([
      { threadId: THREAD_ID, runId: calls.acquired[0]?.runId ?? "" },
    ]);
  });

  test("when the deadline fires", async () => {
    const { run, calls, agent } = harness({
      // Never finishes and never notices the abort: the backstop is what settles this.
      drive: () => undefined,
      turnTimeoutMs: 5,
      abortGraceMs: 5,
    });

    await expect(run()).rejects.toThrow("could not be stopped");

    expect(agent.aborts).toBe(1);
    expect(calls.cleaned).toEqual([
      { threadId: THREAD_ID, runId: calls.acquired[0]?.runId ?? "" },
    ]);
  });

  test("when a heartbeat renew rejects", async () => {
    const { run, calls } = harness({
      drive: ({ agent, observer }) => {
        agent.onAbort = () => observer.complete();
      },
      heartbeatMs: 2,
      renew: () => {
        throw new Error("somebody else holds this lock");
      },
    });

    await expect(run()).rejects.toThrow("somebody else holds this lock");

    expect(calls.cleaned).toEqual([
      { threadId: THREAD_ID, runId: calls.acquired[0]?.runId ?? "" },
    ]);
    // And the timer really was cleared: no second renew, however long we wait.
    const renews = calls.renewed.length;
    await wait(20);
    expect(calls.renewed.length).toBe(renews);
  });

  test("when the deadline fires and the run then finishes inside the grace", async () => {
    const { run, calls } = harness({
      // The abort works: the run ends, with an answer on the agent. It is still a stopped turn, and
      // half a sentence must not be posted into the channel as if it were the reply.
      drive: (context) => {
        context.agent.onAbort = () => answers(context);
      },
      turnTimeoutMs: 5,
      abortGraceMs: 50,
    });

    await expect(run()).rejects.toThrow("was stopped after");

    expect(calls.cleaned).toEqual([
      { threadId: THREAD_ID, runId: calls.acquired[0]?.runId ?? "" },
    ]);
  });
});

describe("one run id, everywhere", () => {
  test("reaches the acquire, every renew and the cleanup", async () => {
    const { run, calls } = harness({
      heartbeatMs: 2,
      drive: ({ observer, agent }) => {
        setTimeout(
          () => answers({ observer, agent, request: null as never }),
          20,
        );
      },
    });

    await run();

    const runId = calls.acquired[0]?.runId;
    expect(typeof runId).toBe("string");
    expect(calls.renewed.length).toBeGreaterThan(1);
    for (const renew of calls.renewed) {
      expect(renew).toEqual({ threadId: THREAD_ID, runId, ttlSeconds: 20 });
    }
    expect(calls.cleaned).toEqual([{ threadId: THREAD_ID, runId }]);
    expect(calls.runs[0]?.input.runId).toBe(runId);
  });

  test("reaches runner.stop when the turn is stopped", async () => {
    const { run, calls } = harness({
      drive: () => undefined,
      turnTimeoutMs: 5,
      abortGraceMs: 5,
    });

    await expect(run()).rejects.toThrow("could not be stopped");

    const runId = calls.acquired[0]?.runId;
    expect(calls.stops).toEqual([{ threadId: THREAD_ID, runId }]);
  });
});

describe("a failed heartbeat stops the turn", () => {
  test("aborts the agent, stops the run, and rethrows", async () => {
    const { run, calls, agent } = harness({
      drive: ({ agent: driven, observer }) => {
        driven.onAbort = () => observer.complete();
      },
      heartbeatMs: 2,
      renew: () => {
        throw new Error("lock lost");
      },
    });

    await expect(run()).rejects.toThrow("lock lost");

    expect(agent.aborts).toBe(1);
    expect(calls.stops).toEqual([
      { threadId: THREAD_ID, runId: calls.acquired[0]?.runId },
    ]);
  });

  test("does not return a reply, even when the Bot had already answered", async () => {
    const { run } = harness({
      drive: ({ agent, observer }) => {
        agent.onAbort = () => {
          answers({ agent, observer, request: null as never });
        };
      },
      heartbeatMs: 2,
      renew: () => {
        throw new Error("lock lost");
      },
    });

    await expect(run()).rejects.toThrow("lock lost");
  });
});

describe("recovering what was said", () => {
  test("falls back to the streamed chunks when no message was added", async () => {
    const { run } = harness({
      drive: ({ agent, observer }) => {
        for (const subscriber of agent.subscribers) {
          void subscriber.onTextMessageEndEvent?.({
            event: {
              type: EventType.TEXT_MESSAGE_END,
              messageId: "streamed_1",
            },
            textMessageBuffer: "Said out loud but never persisted.",
            messages: agent.messages,
            state: agent.state,
            agent,
            // biome-ignore lint/suspicious/noExplicitAny: the subscriber params are not the subject.
          } as any);
        }
        observer.complete();
      },
    });

    expect(await run()).toEqual({
      replyText: "Said out loud but never persisted.",
    });
  });

  test("throws when the turn finished without saying anything", async () => {
    const { run, calls } = harness({
      drive: ({ observer }) => observer.complete(),
    });

    await expect(run()).rejects.toThrow(
      "The turn finished without saying anything.",
    );
    expect(calls.cleaned).toHaveLength(1);
  });

  test("throws when the turn stopped to ask a question", async () => {
    const { run, calls } = harness({
      drive: (context) => {
        context.agent.pendingInterrupts = [
          // biome-ignore lint/suspicious/noExplicitAny: the interrupt's shape is not the subject.
          { id: "interrupt_1" } as any,
        ];
        answers(context);
      },
    });

    await expect(run()).rejects.toThrow("nobody to ask");
    expect(calls.cleaned).toHaveLength(1);
  });
});

describe("a RUN_ERROR through next", () => {
  test("rejects rather than hanging, and does not read as an empty answer", async () => {
    const { run, calls } = harness({
      drive: ({ observer }) => {
        observer.next({
          type: EventType.RUN_ERROR,
          message: "the model refused",
        });
        observer.complete();
      },
    });

    await expect(run()).rejects.toThrow("the model refused");
    expect(calls.cleaned).toHaveLength(1);
  });
});
