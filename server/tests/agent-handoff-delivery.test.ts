import { describe, expect, test } from "bun:test";
import type { AbstractAgent, BaseEvent, Message } from "@ag-ui/client";
import { Observable } from "rxjs";
import { createHandoffDelivery } from "../src/agents/handoff-delivery";
import type { HandoffWork } from "../src/agents/handoff-runner";

/**
 * Turning a hop into a turn.
 *
 * The property that matters is that the addressed Bot joins a conversation rather than answering a
 * question in the dark, and that a run which ended in an error is not mistaken for one that answered.
 */

const WORK: HandoffWork = {
  fromBotId: "assistant",
  toBotId: "researcher",
  actorId: "user-1",
  threadId: "thread-1",
  runId: "run-1",
  depth: 1,
  task: "find the outage window",
};

const PRIOR: Message[] = [
  { id: "m1", role: "user", content: "we had an outage yesterday" },
  { id: "m2", role: "assistant", content: "I will find out when" },
];

const FINISHED = [{ type: "RUN_FINISHED" }] as unknown as BaseEvent[];

/** Enough of an agent for the delivery to hand a conversation to. */
function stubAgent(): AbstractAgent {
  const agent = {
    threadId: "",
    messages: [] as unknown[],
    setMessages(messages: unknown[]) {
      agent.messages = messages;
    },
  };
  return agent as unknown as AbstractAgent;
}

function delivery(
  events: BaseEvent[],
  agent: AbstractAgent | null = stubAgent(),
  lockHeld = true,
  options: { history?: readonly unknown[]; deadlineMs?: number } = {},
) {
  const requests: Array<{
    threadId: string;
    input: Record<string, unknown>;
    persistedInputMessages?: readonly unknown[];
  }> = [];
  const lockCalls: string[] = [];
  const released: string[] = [];
  return {
    requests,
    lockCalls,
    released,
    delivery: createHandoffDelivery({
      ...(options.deadlineMs === undefined
        ? {}
        : { deadlineMs: options.deadlineMs }),
      agentFor: async () => agent,
      history: async () => options.history ?? PRIOR,
      newRunId: () => "run-2",
      mintThreadId: () => "scratch-thread",
      lock: {
        acquire: async () => {
          lockCalls.push("acquire");
          // The platform's own run id, not the one asked for.
          return lockHeld ? { runId: "platform-run" } : null;
        },
        renew: async () => {
          lockCalls.push("renew");
        },
        release: async (input) => {
          lockCalls.push("release");
          released.push(input.threadId);
        },
      },
      runner: {
        run: (request) => {
          requests.push({
            threadId: request.threadId,
            input: request.input as Record<string, unknown>,
            ...(request.persistedInputMessages
              ? { persistedInputMessages: request.persistedInputMessages }
              : {}),
          });
          return new Observable<BaseEvent>((subscriber) => {
            for (const event of events) subscriber.next(event);
            subscriber.complete();
          });
        },
      },
    }),
  };
}

describe("turning a hop into a turn", () => {
  test("the addressed Bot reads the conversation before the ask", async () => {
    const { delivery: deliver, requests } = delivery(FINISHED);

    await deliver.deliver({
      work: WORK,
      message: "assistant has asked you to help",
      shown: "Assistant asked Researcher for this on your behalf: find it",
      assertion: "signed",
    });

    const messages = requests[0]?.input.messages as Message[];
    // The conversation, then the ask. A Bot handed only the task answers a question whose other half
    // was settled three messages ago.
    expect(messages.map((m) => m.id).slice(0, 2)).toEqual(["m1", "m2"]);
    expect(messages.at(-1)).toMatchObject({
      role: "user",
      content: "assistant has asked you to help",
    });
  });

  test("the run carries the deployment's signed statement of what it is", async () => {
    const { delivery: deliver, requests } = delivery(FINISHED);

    await deliver.deliver({
      work: WORK,
      message: "m",
      shown: "s",
      assertion: "signed-assertion",
    });

    expect(requests[0]?.input.forwardedProps).toEqual({
      openbotRun: "signed-assertion",
    });
    // The addressed Bot's own conversation, because a thread has exactly one agent.
    expect(requests[0]?.threadId).toBe("scratch-thread");
  });

  /*
   * A run that errored said nothing in the conversation. Treating it as delivered finishes the work
   * and leaves the person waiting for an answer that will never come.
   */
  test("a run that ended in an error is not a delivery", async () => {
    const { delivery: deliver } = delivery([
      { type: "RUN_ERROR", message: "the model refused" },
    ] as unknown as BaseEvent[]);

    await expect(
      deliver.deliver({ work: WORK, message: "m", shown: "s", assertion: "s" }),
    ).rejects.toThrow("the model refused");
  });

  test("a Bot that cannot be built is worth another go rather than a silent drop", async () => {
    const { delivery: deliver } = delivery(FINISHED, null);

    await expect(
      deliver.deliver({ work: WORK, message: "m", shown: "s", assertion: "s" }),
    ).rejects.toThrow("researcher");
  });
});

/**
 * The conversation's run lock.
 *
 * ONE RUN AT A TIME, and the gateway checks every streamed event against the run the lock names. A
 * delivery that skips this is claiming to be a run nobody was told about, so every event is refused
 * and the refusal reads like a platform limitation rather than a missing step. It was one.
 */
describe("holding the conversation while a Bot answers", () => {
  test("the lock is taken before anything is streamed, and given back after", async () => {
    const { delivery: deliver, lockCalls } = delivery(FINISHED);

    await deliver.deliver({
      work: WORK,
      message: "m",
      shown: "s",
      assertion: "s",
    });

    expect(lockCalls[0]).toBe("acquire");
    expect(lockCalls.at(-1)).toBe("release");
  });

  test("the run uses the platform's own run id", async () => {
    const { delivery: deliver, requests } = delivery(FINISHED);

    await deliver.deliver({
      work: WORK,
      message: "m",
      shown: "s",
      assertion: "s",
    });

    // The platform's id, not the one asked for: it is what the gateway checks every event against.
    expect(requests[0]?.input.runId).toBe("platform-run");
  });

  /*
   * A person mid-question, or the asking Bot still finishing its own sentence, is a wait rather than
   * a failure. The hop goes back on the queue and is tried again.
   */
  test("a conversation somebody else is running in is waited for, not failed", async () => {
    const { delivery: deliver, requests } = delivery(
      FINISHED,
      stubAgent(),
      false,
    );

    await expect(
      deliver.deliver({ work: WORK, message: "m", shown: "s", assertion: "s" }),
    ).rejects.toThrow("busy");
    expect(requests).toEqual([]);
  });

  /*
   * Left held, the conversation is unusable by anybody until it expires: the person cannot ask a
   * follow-up and the next hop is refused. One failed delivery would stop the conversation working.
   */
  test("the lock is given back even when the run fails", async () => {
    const { delivery: deliver, lockCalls } = delivery([
      { type: "RUN_ERROR", message: "the model refused" },
    ] as unknown as BaseEvent[]);

    await expect(
      deliver.deliver({ work: WORK, message: "m", shown: "s", assertion: "s" }),
    ).rejects.toThrow();
    expect(lockCalls).toContain("release");
  });
});

/**
 * Where the turn can run, which the platform decides rather than this code.
 *
 * An Intelligence thread is owned by exactly one agent. A second Bot answering inside the first
 * Bot's conversation is refused however it asks, so its turn runs in a scratch thread of its own
 * and the words come home through the relay.
 */
describe("which conversation the turn runs in", () => {
  test("a scratch thread of the addressed Bot's own, not the one that asked", async () => {
    const { delivery: deliver, requests } = delivery(FINISHED);

    await deliver.deliver({
      work: WORK,
      message: "m",
      shown: "s",
      assertion: "s",
    });

    expect(requests[0]?.threadId).toBe("scratch-thread");
    expect(requests[0]?.input.threadId).toBe("scratch-thread");
  });

  test("but it reads the conversation that asked", async () => {
    const { delivery: deliver, requests } = delivery(FINISHED);

    await deliver.deliver({
      work: WORK,
      message: "m",
      shown: "s",
      assertion: "s",
    });

    // Its own conversation is new and empty; reading that would tell it nothing.
    const messages = requests[0]?.input.messages as Array<{ id: string }>;
    expect(messages.map((m) => m.id).slice(0, 2)).toEqual(["m1", "m2"]);
  });
});

/**
 * What crosses a hop.
 *
 * A thread's stored history is what a person is shown, not a prompt: the assistant message that made
 * a tool call is not kept, so the result of that call is stored on its own with a `toolCallId`
 * matching nothing. The asking Bot's last act is always the call that handed the work on, so every
 * hop carried one of these and every delivery hung on it.
 */
describe("the conversation that crosses a hop", () => {
  test("the asking Bot's tool traffic is left behind", async () => {
    const { delivery: deliver, requests } = delivery(
      FINISHED,
      undefined,
      true,
      {
        history: [
          { id: "m1", role: "user", content: "ask the researcher" },
          // The orphan: a result whose call was never kept.
          {
            id: "m2",
            role: "tool",
            toolCallId: "call_1",
            content: '"Handed to Researcher."',
          },
          // A tool call and nothing else, which is the other half of the same pair.
          { id: "m3", role: "assistant", content: "" },
          { id: "m4", role: "assistant", content: "I have asked them." },
        ],
      },
    );

    await deliver.deliver({
      work: WORK,
      message: "the ask",
      shown: "one line",
      assertion: "s",
    });

    const messages = requests[0]?.input.messages as Message[];
    expect(messages.map((message) => message.id)).toEqual([
      "m1",
      "m4",
      `handoff-platform-run`,
    ]);
  });
});

/**
 * A hop nobody is watching.
 *
 * On a person's own run there is somebody who can reload the page. A hop that never finishes holds
 * the conversation's lock and its place on the queue for as long as the process lives, and the
 * person waits on an answer that is not coming.
 */
describe("a delivery that never finishes", () => {
  test("is given up on, and says so", async () => {
    const { delivery: deliver, lockCalls } = delivery([], stubAgent(), true, {
      deadlineMs: 20,
    });
    // A run that emits nothing and never completes, which is what a stalled Bot looks like.
    const stalled = createHandoffDelivery({
      deadlineMs: 20,
      agentFor: async () => stubAgent(),
      history: async () => PRIOR,
      newRunId: () => "run-2",
      mintThreadId: () => "scratch-thread",
      lock: {
        acquire: async () => ({ runId: "platform-run" }),
        renew: async () => {},
        release: async () => {
          lockCalls.push("release");
        },
      },
      runner: { run: () => new Observable<BaseEvent>(() => {}) },
    });

    await expect(
      stalled.deliver({ work: WORK, message: "m", shown: "s", assertion: "s" }),
    ).rejects.toThrow("did not finish within");
    // Given back, or the conversation stays unusable until the lock expires.
    expect(lockCalls).toContain("release");
    void deliver;
  });

  test("the lock is given back on the conversation it was taken on", async () => {
    const { delivery: deliver, released } = delivery(FINISHED);

    await deliver.deliver({
      work: WORK,
      message: "m",
      shown: "s",
      assertion: "s",
    });

    // Not `thread-1`, which is the conversation that ASKED and whose lock this run never held.
    expect(released).toEqual(["scratch-thread"]);
  });
});

/**
 * What the conversation keeps.
 *
 * The person did not send the ask and it is not addressed to them: their conversation with one Bot
 * has a message in it because another Bot asked for something. Persisting the whole prompt puts the
 * asking conversation's history into a second conversation, and a paragraph of instructions to a
 * model into a bubble that looks like something they typed.
 */
describe("what a hop leaves in the transcript", () => {
  test("is the one line, not the prompt", async () => {
    const { delivery: deliver, requests } = delivery(FINISHED);

    await deliver.deliver({
      work: WORK,
      message: "assistant has asked you to help\n\nTask: ...\nConstraints: ...",
      shown: "Assistant asked Researcher for this on your behalf: find it",
      assertion: "s",
    });

    expect(requests[0]?.persistedInputMessages).toEqual([
      {
        id: "handoff-platform-run",
        role: "user",
        content: "Assistant asked Researcher for this on your behalf: find it",
      },
    ]);
    // The model still gets the whole envelope, and the conversation that asked.
    const messages = requests[0]?.input.messages as Message[];
    expect(messages.at(-1)).toMatchObject({
      content: expect.stringContaining("Task:"),
    });
  });
});

/**
 * Where the conversation has to be put.
 *
 * `runAgent` takes `runId`, `tools`, `context` and `forwardedProps`. AG-UI keeps the messages and
 * the thread on the agent, so a `messages` array passed as a run parameter is ignored in silence:
 * the Bot runs, reads nothing, and answers "how can I help?" to a question printed directly above
 * its reply. Nothing fails, which is why this is a test rather than a comment.
 */
describe("what the addressed Bot is actually given", () => {
  test("the conversation is set on the agent, not only in the run", async () => {
    const agent = stubAgent();
    const { delivery: deliver } = delivery(FINISHED, agent);

    await deliver.deliver({
      work: WORK,
      message: "the ask",
      shown: "one line",
      assertion: "s",
    });

    const given = (agent as unknown as { messages: Message[] }).messages;
    expect(given.map((message) => message.id)).toEqual([
      "m1",
      "m2",
      "handoff-platform-run",
    ]);
    expect(given.at(-1)).toMatchObject({ role: "user", content: "the ask" });
    // And it runs in its own conversation, which the agent also carries.
    expect((agent as unknown as { threadId: string }).threadId).toBe(
      "scratch-thread",
    );
  });
});

/**
 * Lighting the asking channel while a hop runs.
 *
 * A forward hop runs in a scratch thread nobody watches, so it signals the asking channel itself. A
 * backwards hop runs in the asking thread, whose lock the runtime already watches, so it must not
 * signal again — that would double the indicator on and off.
 */
describe("the working indicator", () => {
  function withBusy() {
    const busy: Array<{ threadId: string; busy: boolean }> = [];
    const deliver = createHandoffDelivery({
      agentFor: async () => stubAgent(),
      history: async () => PRIOR,
      newRunId: () => "run-2",
      mintThreadId: () => "scratch-thread",
      setBusy: async (input) => {
        busy.push(input);
      },
      lock: {
        acquire: async () => ({ runId: "platform-run" }),
        renew: async () => {},
        release: async () => {},
      },
      runner: {
        run: () =>
          new Observable<BaseEvent>((subscriber) => {
            for (const event of FINISHED) subscriber.next(event);
            subscriber.complete();
          }),
      },
    });
    return { busy, deliver };
  }

  test("a forward hop lights the asking channel, on then off", async () => {
    const { busy, deliver } = withBusy();

    await deliver.deliver({
      work: WORK,
      message: "m",
      shown: "s",
      assertion: "s",
    });

    // Keyed on the asking thread, not the scratch thread the run happens in.
    expect(busy).toEqual([
      { threadId: "thread-1", busy: true },
      { threadId: "thread-1", busy: false },
    ]);
  });

  test("a backwards hop leaves the indicator to the runtime lock", async () => {
    const { busy, deliver } = withBusy();

    await deliver.deliver({
      work: { ...WORK, answerIn: "thread-1" },
      message: "m",
      assertion: "s",
    });

    expect(busy).toEqual([]);
  });
});

/**
 * What the Bot said, gathered from the stream.
 *
 * The runner publishes the turn to the platform rather than back through the observable, and the
 * scratch thread it lands in is never shown to anybody: the events going past are the one chance to
 * hear the answer, and the resolved value is the only copy the relay — and therefore the person —
 * will ever get.
 */
describe("what comes back for the relay", () => {
  /** An agent whose run emits the given events through the delivery's own onEvent hook. */
  function talkingAgent(
    events: Array<{ type: string; delta?: string }>,
  ): AbstractAgent {
    const agent = {
      threadId: "",
      messages: [] as unknown[],
      setMessages(messages: unknown[]) {
        agent.messages = messages;
      },
      runAgent: (
        _input: unknown,
        config?: { onEvent?: (emitted: unknown) => void },
      ) => {
        for (const event of events) config?.onEvent?.({ event });
        return Promise.resolve();
      },
    };
    return agent as unknown as AbstractAgent;
  }

  /** A runner that drives the agent the way the real one does, then completes. */
  function throughTheAgent(agent: AbstractAgent) {
    return createHandoffDelivery({
      agentFor: async () => agent,
      history: async () => PRIOR,
      newRunId: () => "run-2",
      mintThreadId: () => "scratch-thread",
      lock: {
        acquire: async () => ({ runId: "platform-run" }),
        renew: async () => {},
        release: async () => {},
      },
      runner: {
        run: (request) => {
          void (
            request.agent as unknown as {
              runAgent: (input: unknown, config?: unknown) => Promise<void>;
            }
          ).runAgent({}, {});
          return new Observable<BaseEvent>((subscriber) => {
            for (const event of FINISHED) subscriber.next(event);
            subscriber.complete();
          });
        },
      },
    });
  }

  test("the words the Bot said resolve out of the delivery", async () => {
    const agent = talkingAgent([
      { type: "TEXT_MESSAGE_START" },
      { type: "TEXT_MESSAGE_CONTENT", delta: "The outage " },
      { type: "TEXT_MESSAGE_CONTENT", delta: "was Tuesday." },
      { type: "TEXT_MESSAGE_END" },
    ]);

    const { answer } = await throughTheAgent(agent).deliver({
      work: WORK,
      message: "m",
      shown: "s",
      assertion: "s",
    });

    expect(answer).toBe("The outage was Tuesday.");
  });

  test("a turn that said several things carries all of them", async () => {
    const agent = talkingAgent([
      { type: "TEXT_MESSAGE_START" },
      { type: "TEXT_MESSAGE_CONTENT", delta: "Looking now." },
      { type: "TEXT_MESSAGE_END" },
      { type: "TEXT_MESSAGE_START" },
      { type: "TEXT_MESSAGE_CONTENT", delta: "Found it: Tuesday." },
      { type: "TEXT_MESSAGE_END" },
    ]);

    const { answer } = await throughTheAgent(agent).deliver({
      work: WORK,
      message: "m",
      shown: "s",
      assertion: "s",
    });

    expect(answer).toBe("Looking now.\n\nFound it: Tuesday.");
  });

  test("a turn that spoke announces itself, where the wiring can find a channel", async () => {
    const announced: Array<{
      threadId: string;
      agentId: string;
      text: string;
    }> = [];
    const agent = talkingAgent([
      { type: "TEXT_MESSAGE_START" },
      { type: "TEXT_MESSAGE_CONTENT", delta: "Tuesday." },
      { type: "TEXT_MESSAGE_END" },
    ]);
    const deliver = createHandoffDelivery({
      agentFor: async () => agent,
      history: async () => PRIOR,
      newRunId: () => "run-2",
      mintThreadId: () => "scratch-thread",
      announce: async ({ threadId, agentId, text }) => {
        announced.push({ threadId, agentId, text });
      },
      lock: {
        acquire: async () => ({ runId: "platform-run" }),
        renew: async () => {},
        release: async () => {},
      },
      runner: {
        run: (request) => {
          void (
            request.agent as unknown as {
              runAgent: (input: unknown, config?: unknown) => Promise<void>;
            }
          ).runAgent({}, {});
          return new Observable<BaseEvent>((subscriber) => {
            for (const event of FINISHED) subscriber.next(event);
            subscriber.complete();
          });
        },
      },
    });

    // A backwards hop: the relay, landing where the person is watching.
    await deliver.deliver({
      work: { ...WORK, answerIn: "thread-1" },
      message: "m",
      assertion: "s",
    });

    expect(announced).toEqual([
      { threadId: "thread-1", agentId: WORK.toBotId, text: "Tuesday." },
    ]);
  });

  test("a turn of nothing but tool calls has nothing to carry", async () => {
    const agent = talkingAgent([
      { type: "TOOL_CALL_START" },
      { type: "TOOL_CALL_END" },
    ]);

    const { answer } = await throughTheAgent(agent).deliver({
      work: WORK,
      message: "m",
      shown: "s",
      assertion: "s",
    });

    expect(answer).toBeNull();
  });
});

/**
 * A message is not always a string.
 *
 * AG-UI's user message takes `string | InputContent[]` and the platform types thread content as
 * unknown. Nothing here writes an array yet, which is why a `typeof content === "string"` test
 * looked complete — and why the day attachments ship, every message carrying one would vanish from
 * the conversation handed across a hop with nothing recording it.
 */
describe("a conversation that is not all plain strings", () => {
  test("a message made of parts is carried across, not dropped", async () => {
    const { delivery: deliver, requests } = delivery(
      FINISHED,
      undefined,
      true,
      {
        history: [
          {
            id: "m1",
            role: "user",
            content: [
              { type: "text", text: "here is the invoice" },
              { type: "image", url: "https://example.test/a.png" },
            ],
          },
          { id: "m2", role: "assistant", content: "I will read it" },
        ],
      },
    );

    await deliver.deliver({
      work: WORK,
      message: "the ask",
      shown: "one line",
      assertion: "s",
    });

    const messages = requests[0]?.input.messages as Message[];
    expect(messages.map((message) => message.id)).toEqual([
      "m1",
      "m2",
      "handoff-platform-run",
    ]);
  });

  /*
   * Still dropped: a message whose only content is parts this does not understand says nothing, and
   * an assistant message with nothing in it is a tool call whose other half was never kept.
   */
  test("a message with no text in it at all is still left behind", async () => {
    const { delivery: deliver, requests } = delivery(
      FINISHED,
      undefined,
      true,
      {
        history: [
          { id: "m1", role: "user", content: [{ type: "image", url: "x" }] },
          { id: "m2", role: "assistant", content: [] },
          { id: "m3", role: "user", content: "what does it say?" },
        ],
      },
    );

    await deliver.deliver({
      work: WORK,
      message: "the ask",
      shown: "one line",
      assertion: "s",
    });

    const messages = requests[0]?.input.messages as Message[];
    expect(messages.map((message) => message.id)).toEqual([
      "m3",
      "handoff-platform-run",
    ]);
  });
});

/*
 * The one call that throws on a platform error is the history read, and on a relay the lock is the
 * asking conversation itself. Read while holding it, a failed read leaked the lock until its TTL:
 * the person could not type for two minutes, and the retry collided with the hop's own hold.
 */
describe("a history read that fails", () => {
  test("takes no lock, so nothing is leaked for the retry to collide with", async () => {
    const lockCalls: string[] = [];
    const deliver = createHandoffDelivery({
      agentFor: async () => stubAgent(),
      history: async () => {
        throw new Error("the platform answered 500");
      },
      newRunId: () => "run-2",
      mintThreadId: () => "scratch-thread",
      lock: {
        acquire: async () => {
          lockCalls.push("acquire");
          return { runId: "platform-run" };
        },
        renew: async () => {
          lockCalls.push("renew");
        },
        release: async () => {
          lockCalls.push("release");
        },
      },
      runner: {
        run: () =>
          new Observable<BaseEvent>((subscriber) => {
            subscriber.complete();
          }),
      },
    });

    await expect(
      deliver.deliver({
        work: { ...WORK, answerIn: WORK.threadId },
        message: "you asked researcher; it answered",
        assertion: "signed",
      }),
    ).rejects.toThrow("the platform answered 500");
    expect(lockCalls).toEqual([]);
  });
});
