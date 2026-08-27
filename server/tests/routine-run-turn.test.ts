import { describe, expect, test } from "bun:test";
import type { Message } from "@ag-ui/client";
import { AbstractAgent, EventType } from "@ag-ui/client";
import { EMPTY } from "rxjs";
import {
  createTurnRunner,
  frameFiring,
  sanitizeSeededHistory,
} from "../src/routines/run-turn";

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

/**
 * A fragment of the firing frame that no instruction a person writes would contain by accident, and
 * which every one of the frame's three jobs runs through. Asserted rather than the whole paragraph so
 * the wording can be improved without rewriting the suite.
 */
const FRAME_MARK = "firing right now";

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
  /** What the acquire call does. A thunk that throws, for the same reason `renew` is one. */
  acquireFails?: () => Error;
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
      if (options.acquireFails) throw options.acquireFails();
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

  test("does not leak history into the reply: the before-set must be taken after seeding, not before", async () => {
    // A non-empty history containing an existing assistant row ("Hello back.") is the regression
    // guard the empty-history tests above cannot provide: if `before` were ever taken ABOVE
    // `agent.setMessages(messages)` instead of below it, that seeded row would read as "new" too,
    // and the reply would come back as "Hello back.\n\nThree things happened." instead of just the
    // one line the run actually added.
    const { run } = harness({ history: THREE_ROWS });

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
        // The result that answers `call_1`. Present because the row above is otherwise a dangling
        // call, which `sanitizeSeededHistory` drops — and what this test is about is the conversion,
        // not the sanitation, so the fixture has to be a healthy exchange.
        { id: "m5", role: "tool", content: "found x", toolCallId: "call_1" },
      ],
    });

    await run();

    expect(agent.threadId).toBe(THREAD_ID);
    // The five history rows, then this turn's instruction, then what the run added.
    expect(agent.messages.map((message) => message.id).slice(0, 5)).toEqual([
      "m1",
      "m2",
      "m3",
      "m4",
      "m5",
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
    // And a result row still points at the call it answers.
    expect(agent.messages[4]).toMatchObject({ toolCallId: "call_1" });
    expect(agent.messages[5]).toMatchObject({ role: "user" });
    // The turn's own message carries the instruction, framed as a firing — see the describe below.
    expect(agent.messages[5]?.content).toContain(INSTRUCTION);
    expect(agent.messages[5]?.content).toContain(FRAME_MARK);
  });

  test("a thread the platform has never heard of reads as no history", async () => {
    const { run, calls } = harness({ historyFails: threadNotFound });

    await run();

    expect(calls.runs[0]?.input.messages).toHaveLength(1);
  });
});

/**
 * The turn has to know it IS a firing.
 *
 * FOUND ON A LIVE FIRING. The instruction read "Every run, append the current date and time as a new
 * bulleted list item to the Notion page …" and went to the model verbatim. The model read
 * schedule-shaped prose as a request about SCHEDULING: it called `list_routines`, found a routine
 * that already said that, replied "already configured", and appended nothing. The firing recorded
 * `succeeded` having done nothing — a routine reporting that it works while doing nothing at all,
 * which is worse than one that fails.
 */
describe("the turn's message is framed as a firing happening now", () => {
  test("carries the instruction and the frame around it", async () => {
    const { run, calls } = harness({ history: THREE_ROWS });

    await run();

    const seeded = calls.runs[0]?.input.messages ?? [];
    const turn = seeded[seeded.length - 1] as { content?: unknown };
    expect(typeof turn.content).toBe("string");
    const content = String(turn.content);
    // The instruction survives whole — the frame wraps it, it does not rewrite it.
    expect(content).toContain(INSTRUCTION);
    expect(content).toContain(FRAME_MARK);
    // And the three things the bare instruction could not say.
    expect(content.toLowerCase()).toContain("schedule");
    expect(content.toLowerCase()).toContain("this turn");
    expect(content).toContain("routine");
  });

  test("the framed message is what persists, so the transcript shows what was asked", async () => {
    const { run, calls } = harness({ history: THREE_ROWS });

    await run();

    const [request] = calls.runs;
    expect(request?.persistedInputMessages).toHaveLength(1);
    const persisted = String(request?.persistedInputMessages?.[0]?.content);
    expect(persisted).toContain(FRAME_MARK);
    expect(persisted).toContain(INSTRUCTION);
  });

  test("a prior firing's framed message, arriving back as history, is not framed again", async () => {
    // The framed text persists, so the NEXT firing reads it back as history. Only the new message is
    // framed; history is seeded exactly as the platform handed it over. Without that, an instruction
    // would grow a fresh paragraph of frame on every single firing until the turn is mostly frame.
    const alreadyFramed = frameFiring(
      "Append the current UTC time to the log page.",
    );
    const { run, calls } = harness({
      history: [
        { id: "m1", role: "user", content: alreadyFramed },
        { id: "m2", role: "assistant", content: "Appended." },
      ],
    });

    await run();

    const seeded = calls.runs[0]?.input.messages ?? [];
    expect(seeded).toHaveLength(3);
    // Byte for byte what came out of the platform.
    expect((seeded[0] as { content?: unknown }).content).toBe(alreadyFramed);
    // And exactly one frame in it, not two.
    const occurrences =
      String((seeded[0] as { content?: unknown }).content).split(FRAME_MARK)
        .length - 1;
    expect(occurrences).toBe(1);
    // The new message is the only framed one this turn added.
    expect(String((seeded[2] as { content?: unknown }).content)).toBe(
      frameFiring(INSTRUCTION),
    );
  });
});

/**
 * The seeded history has to be a conversation the model API will ACCEPT, and a thread that was once
 * interrupted mid-tool-call is not one.
 *
 * Found in production: two firings fifteen minutes apart both failed with `Tool result is missing for
 * tool call call_TTbiXzJVNifQt8ioU1JJmj4S.` — the SAME call id both times, so it came from persisted
 * history rather than from the live turn. One interrupted chat turn therefore poisoned every
 * subsequent firing in that channel until the fatigue rule disabled the routine: a permanent failure
 * out of transient damage. These are the properties that keep that from happening again.
 */
describe("the seeded history is sanitized of dangling tool calls", () => {
  test("an unanswered tool call is dropped and the answered one survives, with all text intact", async () => {
    const { run, calls } = harness({
      history: [
        { id: "m1", role: "user", content: "Look two things up." },
        {
          id: "m2",
          role: "assistant",
          content: "Looking them up.",
          toolCalls: [
            { id: "call_answered", name: "search", args: '{"q":"x"}' },
            { id: "call_dangling", name: "search", args: '{"q":"y"}' },
          ],
        },
        {
          id: "m3",
          role: "tool",
          content: "found x",
          toolCallId: "call_answered",
        },
        { id: "m4", role: "assistant", content: "Here is x." },
      ],
    });

    await run();

    const seeded = calls.runs[0]?.input.messages ?? [];
    // Every message survives — nothing said out loud is thrown away — and only the call that has no
    // answer is gone.
    expect(seeded.map((message) => message.id).slice(0, 4)).toEqual([
      "m1",
      "m2",
      "m3",
      "m4",
    ]);
    expect(seeded).toHaveLength(5);
    expect(seeded[1]).toMatchObject({
      content: "Looking them up.",
      toolCalls: [
        {
          id: "call_answered",
          type: "function",
          function: { name: "search", arguments: '{"q":"x"}' },
        },
      ],
    });
    expect(seeded[2]).toMatchObject({ toolCallId: "call_answered" });
  });

  test("an assistant message whose only content was a dangling tool call is dropped entirely", async () => {
    // An assistant row with neither text nor tool calls is itself invalid for some providers, so
    // stripping the call is not enough: the husk has to go too.
    const { run, calls } = harness({
      history: [
        { id: "m1", role: "user", content: "Look it up." },
        {
          id: "m2",
          role: "assistant",
          toolCalls: [{ id: "call_dangling", name: "search", args: "{}" }],
        },
        { id: "m3", role: "user", content: "Anything?" },
      ],
    });

    await run();

    const seeded = calls.runs[0]?.input.messages ?? [];
    expect(seeded.map((message) => message.id).slice(0, 2)).toEqual([
      "m1",
      "m3",
    ]);
    expect(seeded).toHaveLength(3);
  });

  test("an orphaned tool result is dropped", async () => {
    // The mirror-image dangle: a result whose call is not in the history at all.
    const { run, calls } = harness({
      history: [
        { id: "m1", role: "user", content: "Hello." },
        {
          id: "m2",
          role: "tool",
          content: "left over",
          toolCallId: "call_gone",
        },
        { id: "m3", role: "assistant", content: "Hello back." },
      ],
    });

    await run();

    const seeded = calls.runs[0]?.input.messages ?? [];
    expect(seeded.map((message) => message.id).slice(0, 2)).toEqual([
      "m1",
      "m3",
    ]);
    expect(seeded).toHaveLength(3);
  });

  test("a clean history passes through unchanged, object for object", () => {
    const clean = [
      { id: "m1", role: "user", content: "Look it up." },
      {
        id: "m2",
        role: "assistant",
        content: "Looking it up.",
        toolCalls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "search", arguments: "{}" },
          },
        ],
      },
      { id: "m3", role: "tool", content: "found", toolCallId: "call_1" },
      { id: "m4", role: "assistant", content: "Here it is." },
    ] as unknown as Message[];
    const snapshot = structuredClone(clean);

    const sanitized = sanitizeSeededHistory(clean);

    // Nothing reordered, nothing rewritten — and not even reallocated, so there is no room for a
    // silent normalization to creep in on the overwhelmingly common healthy-thread path.
    expect(sanitized).toEqual(snapshot);
    for (const [index, message] of sanitized.entries()) {
      expect(message).toBe(clean[index]);
    }
    // And the caller's array was not mutated underneath it.
    expect(clean).toEqual(snapshot);
  });
});

describe("persistedInputMessages is the subtraction", () => {
  test("a history of three plus one new message persists exactly the new one", async () => {
    const { run, calls } = harness({ history: THREE_ROWS });

    await run();

    const [request] = calls.runs;
    expect(request?.input.messages).toHaveLength(4);
    expect(request?.persistedInputMessages).toHaveLength(1);
    expect(request?.persistedInputMessages?.[0]?.content).toContain(
      INSTRUCTION,
    );
    // Identified by id, not by position: none of the history's ids may appear.
    const historic = new Set(THREE_ROWS.map((row) => row.id));
    for (const message of request?.persistedInputMessages ?? []) {
      expect(historic.has(message.id)).toBe(false);
    }
  });

  test("a history carrying a dangle persists exactly the new message, and nothing sanitized", async () => {
    // The subtraction is over the ids the PLATFORM handed back, and sanitizing changes no id: a
    // message the sanitizer stripped a tool call from keeps its id and so is still subtracted out,
    // and a message it dropped was never a candidate to persist in the first place. So a dangle
    // must not turn this firing into one that re-persists half the transcript.
    const { run, calls } = harness({
      history: [
        ...THREE_ROWS,
        {
          id: "m4",
          role: "assistant",
          toolCalls: [{ id: "call_dangling", name: "search", args: "{}" }],
        },
      ],
    });

    await run();

    const [request] = calls.runs;
    // Three seeded rows survive the sanitation, plus this turn's instruction.
    expect(request?.input.messages).toHaveLength(4);
    expect(request?.persistedInputMessages).toHaveLength(1);
    expect(request?.persistedInputMessages?.[0]?.content).toContain(
      INSTRUCTION,
    );
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

describe("cleanup only runs for a lock that was actually taken", () => {
  test("a rejected acquire never cleans up, renews, or starts the heartbeat", async () => {
    // `ɵcleanupThreadLock` is DELETE on the platform's lock endpoint. If cleanup ran when the
    // acquire itself failed, it would delete whoever DOES hold the lock — the person's own browser
    // session, most likely. So this is not just "no cleanup call happened to be made", it is "no
    // cleanup call may ever be made when we never held anything to begin with".
    const { run, calls } = harness({
      acquireFails: () => new Error("lock service unavailable"),
      heartbeatMs: 2,
    });

    await expect(run()).rejects.toThrow("lock service unavailable");

    expect(calls.cleaned).toEqual([]);
    expect(calls.renewed).toEqual([]);
    // And no heartbeat was ever scheduled: still nothing, even after it would have ticked.
    await wait(20);
    expect(calls.renewed).toEqual([]);
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

  test("stops the run exactly once when the heartbeat rejects and the deadline also fires", async () => {
    // Two independent callers of `stopTurn` — the heartbeat-reject path and the deadline path — can
    // both fire in the same run. `runner.stop` deletes the platform's stop-requested flag work for
    // one run id; issuing it twice is not double-safe the way the lock cleanup's `.catch` is, it is
    // just two racing calls. The `stopPromise ??=` dedup (mirroring `channel-manager.mjs:222-229`)
    // is what keeps this to exactly one call regardless of which path got there first.
    const { run, calls } = harness({
      drive: () => undefined,
      heartbeatMs: 2,
      turnTimeoutMs: 20,
      abortGraceMs: 50,
      renew: () => {
        throw new Error("somebody else holds this lock");
      },
    });

    await expect(run()).rejects.toThrow("could not be stopped");

    expect(calls.stops).toHaveLength(1);
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

  test("throws the interrupt sentence, not the empty-reply one, when the turn interrupted before saying anything", async () => {
    // Both conditions are true at once here: no new assistant message AND a pending interrupt. Only
    // one sentence can go on the run row and into the channel, and "finished without saying
    // anything" would be a lie about a turn that in fact stopped to ask a question.
    const { run } = harness({
      drive: ({ observer, agent }) => {
        agent.pendingInterrupts = [
          // biome-ignore lint/suspicious/noExplicitAny: the interrupt's shape is not the subject.
          { id: "interrupt_1" } as any,
        ];
        observer.complete();
      },
    });

    await expect(run()).rejects.toThrow(
      "The turn stopped to ask a question, and a routine has nobody to ask.",
    );
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
