import { describe, expect, test } from "bun:test";
import type {
  AbstractAgent,
  BaseEvent,
  Message,
  Observable,
} from "@ag-ui/client";
import { EventType } from "@ag-ui/client";
import { ActionRefusedError } from "../src/computer/gateway";
import type { ComputerGateway } from "../src/computer/gateway";
import {
  createRoutineRunner,
  RoutineBotUnavailableError,
  UNATTENDED_TOOLS,
} from "../src/routines/runner";

/**
 * What an unattended run must do, tested as properties rather than as a transcript.
 *
 * The four that matter, and none of them are visible from a green typecheck:
 *  - a tool call reaches the GATEWAY, so the same policy and the same audit row apply to work
 *    nobody is watching
 *  - every call carries `unattended`, which is the only thing a rule about routines has to go on
 *  - a tool the run does not provide is ANSWERED, never silently dropped
 *  - a run that goes wrong reaches the caller as a failure, not as a summary that reads like success
 *
 * The agent is a fake that emits AG-UI events, because every interesting case here is about what the
 * runner does with what a model asked for, and a real model cannot be made to ask for a tool that
 * does not exist on demand.
 */

/**
 * The observable the runner actually consumes, which is `subscribe` and nothing else.
 *
 * Hand-rolled rather than built with rxjs so this file depends on the same package the server does
 * and no more. Emitting synchronously inside `subscribe` is deliberate: it is the shape that catches
 * a runner reaching for its own subscription from inside the callback that creates it.
 */
function stream(events: BaseEvent[], failure?: Error): Observable<BaseEvent> {
  return {
    subscribe(observer: {
      next?: (event: BaseEvent) => void;
      error?: (caught: unknown) => void;
      complete?: () => void;
    }) {
      if (failure) {
        observer.error?.(failure);
      } else {
        for (const event of events) observer.next?.(event);
        observer.complete?.();
      }
      return { unsubscribe: () => undefined };
    },
  } as unknown as Observable<BaseEvent>;
}

/** A scripted model: one array of events per turn, in order. */
function scriptedAgent(turns: BaseEvent[][]): AbstractAgent {
  let turn = 0;
  return {
    run: () => {
      const events = turns[turn] ?? [];
      turn += 1;
      return stream(events);
    },
  } as unknown as AbstractAgent;
}

/**
 * A scripted model that also keeps what it was handed.
 *
 * The answer to a tool call is not in the run's outcome; it is in the messages the runner passes to
 * the NEXT turn. Anything asserting about what a model was told has to read it from there.
 */
function recordingAgent(turns: BaseEvent[][]) {
  let turn = 0;
  const toolMessages: string[][] = [];
  const agent = {
    run: (input: { messages: Message[] }) => {
      toolMessages.push(
        input.messages
          .filter((message) => message.role === "tool")
          .map((message) => (message as { content: string }).content),
      );
      const events = turns[turn] ?? [];
      turn += 1;
      return stream(events);
    },
  } as unknown as AbstractAgent;
  return { agent, toolMessages };
}

/**
 * The split form of a message: START, one or more CONTENT deltas, END.
 *
 * See `chunked` below for the other spelling. Both are in the protocol and both are tested, because
 * which one arrives depends on the agent rather than on anything the runner controls.
 */
const says = (delta: string): BaseEvent[] => [
  { type: EventType.TEXT_MESSAGE_START, messageId: "m1" } as BaseEvent,
  {
    type: EventType.TEXT_MESSAGE_CONTENT,
    messageId: "m1",
    delta,
  } as unknown as BaseEvent,
  { type: EventType.TEXT_MESSAGE_END, messageId: "m1" } as BaseEvent,
];

/** The chunk form, which is what the built-in Bot actually emits. */
const chunked = (delta: string): BaseEvent[] => [
  {
    type: EventType.TEXT_MESSAGE_CHUNK,
    role: "assistant",
    messageId: "m1",
    delta,
  } as unknown as BaseEvent,
];

const calls = (
  id: string,
  name: string,
  args: Record<string, unknown>,
): BaseEvent[] => [
  {
    type: EventType.TOOL_CALL_START,
    toolCallId: id,
    toolCallName: name,
  } as unknown as BaseEvent,
  {
    type: EventType.TOOL_CALL_ARGS,
    toolCallId: id,
    delta: JSON.stringify(args),
  } as unknown as BaseEvent,
  { type: EventType.TOOL_CALL_END, toolCallId: id } as unknown as BaseEvent,
];

/** A gateway that records what reached it, so "went through the gateway" is checkable. */
function fakeGateway() {
  const seen: {
    method: string;
    botId: string;
    unattended: boolean | undefined;
    input: unknown;
  }[] = [];
  const record =
    (method: string, result: Record<string, unknown>) =>
    (
      _computerId: string,
      botId: string,
      actor: { unattended?: boolean },
      input?: unknown,
    ) => {
      seen.push({ method, botId, unattended: actor.unattended, input });
      return Promise.resolve(result);
    };

  const gateway = {
    snapshot: (botId: string) => {
      seen.push({
        method: "snapshot",
        botId,
        unattended: undefined,
        input: undefined,
      });
      return Promise.resolve({
        snapshotId: 3,
        url: "https://example.com/",
        title: "Example",
        truncated: false,
        elements: [{ ref: "e1", role: "button", name: "Send" }],
      });
    },
    read: (botId: string) => {
      seen.push({
        method: "read",
        botId,
        unattended: undefined,
        input: undefined,
      });
      return Promise.resolve({
        url: "https://example.com/",
        title: "Example",
        text: "hello",
        truncated: false,
      });
    },
    navigate: record("navigate", { url: "https://example.com/", title: "E" }),
    click: record("click", { action: "click" }),
    type: record("type", { action: "type" }),
    key: record("key", { action: "key" }),
    scroll: record("scroll", { action: "scroll" }),
    readFile: record("readFile", { path: "notes.md", text: "kept" }),
    writeFile: record("writeFile", { path: "notes.md", bytes: 4 }),
    listFiles: record("listFiles", { path: ".", entries: [] }),
  } as unknown as ComputerGateway;
  return { gateway, seen };
}

const REQUEST = {
  agentId: "risk-analyst",
  prompt: "Check the overnight alerts.",
  threadId: "thread-1",
  actor: { id: "someone", userId: "someone", unattended: true },
};

describe("running a routine with nobody watching", () => {
  test("puts the routine's prompt to the Bot and reports what it said", async () => {
    const { gateway } = fakeGateway();
    const runner = createRoutineRunner({
      gateway,
      resolveAgent: async () => scriptedAgent([says("Nothing overnight.")]),
    });

    const outcome = await runner.run(REQUEST);
    expect(outcome.summary).toBe("Nothing overnight.");
    expect(outcome.turns).toBe(1);
    expect(outcome.stoppedAtCap).toBe(false);
  });

  /*
   * The failure this prevents is the quietest one there is: a run that completes, is recorded as
   * successful, and has an empty summary. Nothing anywhere says it went wrong, and the person reads
   * "it ran and found nothing". Text arrives as a single CHUNK from the built-in Bot and as
   * START/CONTENT/END from other agents, and reading only one spelling produces exactly that.
   */
  test("reads a message that arrives as one chunk, not only as split events", async () => {
    const { gateway } = fakeGateway();
    const runner = createRoutineRunner({
      gateway,
      resolveAgent: async () => scriptedAgent([chunked("Nothing overnight.")]),
    });

    expect((await runner.run(REQUEST)).summary).toBe("Nothing overnight.");
  });

  test("reads a tool call that arrives as chunks", async () => {
    const { gateway, seen } = fakeGateway();
    const runner = createRoutineRunner({
      gateway,
      resolveAgent: async () =>
        scriptedAgent([
          [
            {
              type: EventType.TOOL_CALL_CHUNK,
              toolCallId: "t1",
              toolCallName: "computer_click",
              delta: '{"ref":"e1",',
            } as unknown as BaseEvent,
            // A continuation carrying neither an id nor a name, which is legal and is where the
            // arguments get truncated if the reducer forgets which call is open.
            {
              type: EventType.TOOL_CALL_CHUNK,
              delta: '"snapshotId":3}',
            } as unknown as BaseEvent,
          ],
          chunked("Pressed it."),
        ]),
    });

    await runner.run(REQUEST);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.method).toBe("click");
    expect(seen[0]?.input).toEqual({ ref: "e1", snapshotId: 3 });
  });

  test("the prompt reaches the model as the person's own message", async () => {
    const { gateway } = fakeGateway();
    let firstMessage: Message | undefined;
    const runner = createRoutineRunner({
      gateway,
      resolveAgent: async () =>
        ({
          run: (input: { messages: Message[] }) => {
            firstMessage = input.messages[0];
            return stream(says("Done."));
          },
        }) as unknown as AbstractAgent,
    });

    await runner.run(REQUEST);
    expect(firstMessage?.role).toBe("user");
    expect((firstMessage as { content: string }).content).toBe(
      "Check the overnight alerts.",
    );
  });

  /*
   * The whole point of the design. The browser executes these tools so that it can render them; the
   * decision, the audit row and the action have always happened on the server. An unattended run
   * therefore does not need a weaker path, and this asserts that it does not have one.
   */
  test("every tool call goes through the gateway, marked unattended", async () => {
    const { gateway, seen } = fakeGateway();
    const runner = createRoutineRunner({
      gateway,
      resolveAgent: async () =>
        scriptedAgent([
          calls("t1", "computer_snapshot", {}),
          calls("t2", "computer_click", { ref: "e1", snapshotId: 3 }),
          says("Sent."),
        ]),
    });

    await runner.run(REQUEST);

    expect(seen.map((call) => call.method)).toEqual(["snapshot", "click"]);
    const click = seen[1];
    expect(click?.botId).toBe("risk-analyst");
    // The one fact a boundary has to go on. Without it `run.unattended` is always false and a rule
    // written about routines never matches anything.
    expect(click?.unattended).toBe(true);
    expect(click?.input).toEqual({ ref: "e1", snapshotId: 3 });
  });

  test("the file tools reach the gateway too, not the computer directly", async () => {
    const { gateway, seen } = fakeGateway();
    const runner = createRoutineRunner({
      gateway,
      resolveAgent: async () =>
        scriptedAgent([
          calls("t1", "computer_write_file", {
            path: "alerts.md",
            contents: "nothing",
          }),
          says("Written."),
        ]),
    });

    await runner.run(REQUEST);
    expect(seen[0]?.method).toBe("writeFile");
    expect(seen[0]?.unattended).toBe(true);
  });

  /*
   * A refusal has to arrive as words. A Bot told which boundary stopped it can say so and stop; one
   * handed an empty result tries the same thing another way, which is the behaviour a boundary is
   * meant to prevent rather than provoke.
   */
  test("a refusal comes back to the model with the rule that caused it", async () => {
    const { gateway } = fakeGateway();
    const rule = 'run.unattended && intent == "activate"';
    const refusing = {
      ...gateway,
      click: () => {
        throw new ActionRefusedError(
          "This deployment's policy does not allow that.",
          rule,
        );
      },
    } as unknown as ComputerGateway;

    const { agent, toolMessages } = recordingAgent([
      calls("t1", "computer_click", { ref: "e1", snapshotId: 3 }),
      says("I was not allowed to press it."),
    ]);
    const runner = createRoutineRunner({
      gateway: refusing,
      resolveAgent: async () => agent,
    });

    const outcome = await runner.run(REQUEST);
    const answer = toolMessages[1]?.[0] ?? "";
    expect(JSON.parse(answer)).toEqual({
      ok: false,
      refused: true,
      reason: "This deployment's policy does not allow that.",
      rule,
    });
    expect(outcome.summary).toBe("I was not allowed to press it.");
  });

  test("an ordinary failure is reported without claiming a boundary refused it", async () => {
    const { gateway } = fakeGateway();
    const breaking = {
      ...gateway,
      navigate: () => {
        throw new Error("The assistant's computer could not be reached.");
      },
    } as unknown as ComputerGateway;

    const { agent, toolMessages } = recordingAgent([
      calls("t1", "computer_navigate", { url: "https://example.com/" }),
      says("The page would not open."),
    ]);
    const runner = createRoutineRunner({
      gateway: breaking,
      resolveAgent: async () => agent,
    });

    await runner.run(REQUEST);
    const answer = JSON.parse(toolMessages[1]?.[0] ?? "{}") as {
      ok: boolean;
      refused?: boolean;
      reason: string;
    };
    expect(answer.ok).toBe(false);
    // Not a refusal. Reporting a broken computer as a policy decision sends somebody to edit a rule
    // that had nothing to do with it.
    expect(answer.refused).toBeUndefined();
    expect(answer.reason).toContain("could not be reached");
  });

  /*
   * The requirement that is easiest to fail by doing nothing. A tool call that vanishes leaves the
   * model waiting for a result it will never get, and the usual symptom is a run that repeats itself
   * until the turn cap stops it.
   */
  test("a tool this run does not have is answered, not dropped", async () => {
    const { gateway, seen } = fakeGateway();
    const { agent, toolMessages } = recordingAgent([
      calls("t1", "computer_request_help", { reason: "sign me in" }),
      says("I could not sign in and nobody was there to help."),
    ]);
    const runner = createRoutineRunner({
      gateway,
      resolveAgent: async () => agent,
    });

    const outcome = await runner.run(REQUEST);

    // Nothing reached the gateway: there is no gateway method for asking a person a question.
    expect(seen).toEqual([]);
    const answer = toolMessages[1]?.[0] ?? "";
    expect(answer).toContain("computer_request_help");
    expect(answer).toContain("not available in an unattended run");
    expect(outcome.summary).toBe(
      "I could not sign in and nobody was there to help.",
    );
  });

  test("a Bot the owner cannot run is refused before anything is attempted", async () => {
    const { gateway, seen } = fakeGateway();
    const runner = createRoutineRunner({
      gateway,
      resolveAgent: async () => null,
    });

    await expect(runner.run(REQUEST)).rejects.toBeInstanceOf(
      RoutineBotUnavailableError,
    );
    expect(seen).toEqual([]);
  });

  /*
   * A failed model or a broken transport is a failed RUN. It has to reach the caller as an exception
   * so the run is recorded as failed, rather than being folded into a summary that reads like an
   * answer and leaves somebody believing the routine worked.
   */
  test("a run error is raised rather than summarised", async () => {
    const { gateway } = fakeGateway();
    const runner = createRoutineRunner({
      gateway,
      resolveAgent: async () =>
        scriptedAgent([
          [
            {
              type: EventType.RUN_ERROR,
              message: "the model is unreachable",
            } as unknown as BaseEvent,
          ],
        ]),
    });

    await expect(runner.run(REQUEST)).rejects.toThrow(
      "the model is unreachable",
    );
  });

  test("a stream that errors synchronously is a failed run too", async () => {
    const { gateway } = fakeGateway();
    const runner = createRoutineRunner({
      gateway,
      resolveAgent: async () =>
        ({
          run: () => stream([], new Error("the connection closed")),
        }) as unknown as AbstractAgent,
    });

    await expect(runner.run(REQUEST)).rejects.toThrow("the connection closed");
  });

  /*
   * A model that keeps re-snapshotting a page that never changes will do it as fast as the computer
   * answers. The cap turns that from a night into a few minutes, and it has to be visible in the
   * summary or the run history claims the routine finished.
   */
  test("stops at the turn cap and says so", async () => {
    const { gateway, seen } = fakeGateway();
    const runner = createRoutineRunner({
      gateway,
      maxTurns: 3,
      resolveAgent: async () =>
        ({
          run: () => stream(calls("t1", "computer_snapshot", {})),
        }) as unknown as AbstractAgent,
    });

    const outcome = await runner.run(REQUEST);
    expect(outcome.stoppedAtCap).toBe(true);
    expect(outcome.turns).toBe(3);
    expect(outcome.summary).toContain("stopped after 3 turns");
    expect(seen).toHaveLength(3);
  });

  test("arguments that are not JSON are refused rather than guessed at", async () => {
    const { gateway, seen } = fakeGateway();
    const { agent, toolMessages } = recordingAgent([
      [
        {
          type: EventType.TOOL_CALL_START,
          toolCallId: "t1",
          toolCallName: "computer_navigate",
        } as unknown as BaseEvent,
        {
          type: EventType.TOOL_CALL_ARGS,
          toolCallId: "t1",
          delta: "{not json",
        } as unknown as BaseEvent,
      ],
      says("I could not read my own request."),
    ]);
    const runner = createRoutineRunner({
      gateway,
      resolveAgent: async () => agent,
    });

    await runner.run(REQUEST);
    expect(seen).toEqual([]);
    expect(toolMessages[1]?.[0] ?? "").toContain("not valid JSON");
  });

  test("a click without a snapshotId is answered rather than attempted", async () => {
    const { gateway, seen } = fakeGateway();
    const { agent, toolMessages } = recordingAgent([
      calls("t1", "computer_click", { ref: "e1" }),
      says("I need to take a snapshot first."),
    ]);
    const runner = createRoutineRunner({
      gateway,
      resolveAgent: async () => agent,
    });

    await runner.run(REQUEST);
    expect(seen).toEqual([]);
    expect(toolMessages[1]?.[0] ?? "").toContain("Take a snapshot first");
  });
});

describe("the tools an unattended run offers", () => {
  /*
   * These three are all requests for a person, and there is no person. Offering them would produce a
   * run that waits ten minutes for an answer nobody will give, which is the difference between a
   * routine that finishes and one that hangs until its cap.
   */
  test.each([
    "computer_request_help",
    "computer_request_secret",
    "report_refusal",
  ])("does not offer %s", (name) => {
    expect(UNATTENDED_TOOLS.map((tool) => tool.name)).not.toContain(name);
  });

  test("offers every tool that maps onto a gateway method", () => {
    expect(UNATTENDED_TOOLS.map((tool) => tool.name).sort()).toEqual([
      "computer_click",
      "computer_key",
      "computer_list_files",
      "computer_navigate",
      "computer_read",
      "computer_read_file",
      "computer_scroll",
      "computer_snapshot",
      "computer_type",
      "computer_write_file",
    ]);
  });

  test("every tool describes itself, because the model has nothing else to go on", () => {
    for (const tool of UNATTENDED_TOOLS) {
      expect(tool.description.length).toBeGreaterThan(40);
    }
  });
});
