import { describe, expect, test } from "bun:test";
import type { Message } from "@ag-ui/client";
import {
  HeadlessToolSuspension,
  OPENBOT_WAITING_METADATA,
} from "../src/headless-tools";
import {
  settle,
  type TurnEvidence,
  turnInput,
  turnMessages,
} from "../src/run-turn";

/**
 * How a headless turn ends, decided without running one.
 *
 * `routine-run-turn.test.ts` drives every exit path through a real runner; this file pins the one
 * decision those paths feed, so a change to the order is a change to a table rather than a reading
 * of the runner's control flow.
 */

const REPLY: Message = {
  id: "assistant_1",
  role: "assistant",
  content: "Three things happened.",
};

function evidence(overrides: Partial<TurnEvidence> = {}): TurnEvidence {
  return {
    stopped: false,
    added: [],
    chunks: [],
    pendingInterrupts: [],
    componentNames: new Set(),
    ...overrides,
  };
}

const waiting = new HeadlessToolSuspension("Waiting for Ada.", {
  kind: "approval",
  requestId: "request_1",
});

const interrupt = (metadata?: Record<string, unknown>) =>
  ({ id: "interrupt_1", ...(metadata ? { metadata } : {}) }) as never;

describe("settle", () => {
  test("a run that answered completes with what it said", () => {
    expect(settle(evidence({ added: [REPLY] }))).toEqual({
      kind: "completed",
      replyText: "Three things happened.",
      components: [],
    });
  });

  test("falls back to the streamed chunks when nothing was added", () => {
    expect(settle(evidence({ chunks: ["One.", "Two."] }))).toEqual({
      kind: "completed",
      replyText: "One.\n\nTwo.",
      components: [],
    });
  });

  test("nothing said and nothing pending is empty", () => {
    expect(settle(evidence())).toEqual({ kind: "empty" });
  });

  /*
   * Each row adds one condition that outranks everything below it, on top of evidence that would
   * otherwise settle as the row below. The order is the contract.
   */
  const failure = new Error("the model refused");
  const lost = new Error("lock lost");
  const ladder: [string, TurnEvidence, string][] = [
    [
      "a failure that escaped the run outranks everything",
      evidence({
        failed: { error: failure },
        heartbeatError: lost,
        stopped: true,
        waiting,
        added: [REPLY],
      }),
      "failed",
    ],
    [
      "a lost lock outranks the deadline",
      evidence({
        heartbeatError: lost,
        stopped: true,
        waiting,
        added: [REPLY],
      }),
      "lockLost",
    ],
    [
      "the deadline outranks a waiting",
      evidence({ stopped: true, waiting, added: [REPLY] }),
      "timedOut",
    ],
    [
      "an announced waiting outranks a reply",
      evidence({ waiting, added: [REPLY] }),
      "suspended",
    ],
    [
      "a waiting carried on the interrupt outranks a reply",
      evidence({
        added: [REPLY],
        pendingInterrupts: [
          interrupt({ [OPENBOT_WAITING_METADATA]: { kind: "question" } }),
        ],
      }),
      "suspended",
    ],
    [
      "a bare interrupt outranks a reply",
      evidence({ added: [REPLY], pendingInterrupts: [interrupt()] }),
      "interrupted",
    ],
    [
      "a bare interrupt outranks saying nothing",
      evidence({ pendingInterrupts: [interrupt()] }),
      "interrupted",
    ],
  ];
  for (const [name, input, kind] of ladder) {
    test(name, () => {
      expect(settle(input).kind).toBe(kind);
    });
  }

  test("a failure keeps the exact value the run rejected with, even undefined", () => {
    expect(settle(evidence({ failed: { error: undefined } }))).toEqual({
      kind: "failed",
      error: undefined,
    });
  });

  test("the announced waiting wins over the copy carried on the interrupt", () => {
    const outcome = settle(
      evidence({
        waiting,
        pendingInterrupts: [
          interrupt({
            [OPENBOT_WAITING_METADATA]: {
              kind: "question",
              requestId: "other",
            },
          }),
        ],
      }),
    );
    expect(outcome).toEqual({ kind: "suspended", suspension: waiting });
  });

  test("a carried waiting without a kind is not a waiting", () => {
    expect(
      settle(
        evidence({
          pendingInterrupts: [
            interrupt({ [OPENBOT_WAITING_METADATA]: { requestId: "r" } }),
          ],
        }),
      ).kind,
    ).toBe("interrupted");
  });

  test("components are reported only by the names it was given", () => {
    const drew: Message[] = [
      {
        id: "a",
        role: "assistant",
        content: "Here.",
        toolCalls: [
          {
            id: "c1",
            type: "function",
            function: { name: "showBarChart", arguments: '{"title":"Top"}' },
          },
        ],
      },
      { id: "t", role: "tool", toolCallId: "c1", content: "saved" },
    ];
    expect(
      settle(
        evidence({ added: drew, componentNames: new Set(["showBarChart"]) }),
      ),
    ).toEqual({
      kind: "completed",
      replyText: "Here.",
      components: [{ name: "showBarChart", args: { title: "Top" } }],
    });
    expect(settle(evidence({ added: drew }))).toEqual({
      kind: "completed",
      replyText: "Here.",
      components: [],
    });
  });
});

describe("turnMessages", () => {
  const seeded: Message[] = [
    { id: "m1", role: "user", content: "Hello." },
    { id: "m2", role: "assistant", content: "Hello back." },
  ];
  const turn: Message = { id: "now", role: "user", content: "Again." };

  test("a fresh turn is the history plus its own message, and persists only that message", () => {
    const { messages, persistedInputMessages } = turnMessages({
      seeded,
      historicIds: new Set(["m1", "m2"]),
      turn,
    });
    expect(messages.map((message) => message.id)).toEqual(["m1", "m2", "now"]);
    expect(persistedInputMessages.map((message) => message.id)).toEqual([
      "now",
    ]);
  });

  test("a continuation is its snapshot plus the answer, and never the turn message", () => {
    const { messages, persistedInputMessages } = turnMessages({
      seeded,
      historicIds: new Set(["m1"]),
      turn,
      continuation: {
        snapshot: {
          runId: "run",
          threadId: "thread",
          toolCallId: "call_1",
          toolName: "send",
          args: {},
          messages: [
            { id: "m1", role: "user", content: "Send it." },
            {
              id: "a1",
              role: "assistant",
              content: "",
              toolCalls: [
                {
                  id: "call_1",
                  type: "function",
                  function: { name: "send", arguments: "{}" },
                },
              ],
            },
          ],
          state: {},
          context: [],
          forwardedProps: undefined,
        },
        result: { content: "approved" },
        messageId: "answer_1",
      },
    });
    expect(messages.map((message) => message.id)).toEqual([
      "m1",
      "a1",
      "answer_1",
    ]);
    expect(persistedInputMessages.map((message) => message.id)).toEqual([
      "a1",
      "answer_1",
    ]);
  });
});

describe("turnInput", () => {
  const tools = [
    {
      definition: { name: "offered", description: "", parameters: {} },
      execute: async () => "",
    },
    {
      definition: { name: "refusal_only", description: "", parameters: {} },
      hidden: true,
      execute: async () => "",
    },
  ];

  test("offers only the tools that are not hidden, and resumes nothing on a fresh turn", () => {
    const input = turnInput({
      threadId: "thread",
      runId: "run",
      messages: [],
      state: {},
      tools,
    });
    expect(input.tools.map((tool) => tool.name)).toEqual(["offered"]);
    expect(input.context).toEqual([]);
    expect("resume" in input).toBe(false);
  });
});
