import { describe, expect, test } from "bun:test";
import {
  AbstractAgent,
  EventType,
  type BaseEvent,
  type RunAgentInput,
  type Tool,
} from "@ag-ui/client";
import { lastValueFrom, Observable, of, toArray } from "rxjs";
import { RemoteLearnedSkillsMiddleware } from "../src/learning/remote";
import type { LearnedSkillInvocation } from "../src/learning/runtime";

const load: Tool = {
  name: "copilotkit_load_skill",
  description: "Read a learned skill",
  parameters: {
    type: "object",
    properties: { skill_name: { type: "string" } },
  },
};
const read: Tool = { ...load, name: "copilotkit_read_skill_file" };
const input: RunAgentInput = {
  threadId: "thread",
  runId: "run",
  messages: [{ id: "user", role: "user", content: "Use the refund skill" }],
  state: {},
  tools: [],
  context: [],
  forwardedProps: {
    openbotDeploymentTools: ["governed_action"],
    openbotRun: "signed",
  },
};
const start: BaseEvent = {
  type: EventType.RUN_STARTED,
  threadId: "thread",
  runId: "run",
};
const finish: BaseEvent = {
  type: EventType.RUN_FINISHED,
  threadId: "thread",
  runId: "run",
};
function call(name = load.name, id = "call"): BaseEvent[] {
  return [
    {
      type: EventType.TOOL_CALL_START,
      toolCallId: id,
      toolCallName: name,
      parentMessageId: "assistant",
    },
    {
      type: EventType.TOOL_CALL_ARGS,
      toolCallId: id,
      delta: '{"skill_name":"refund"}',
    },
    { type: EventType.TOOL_CALL_END, toolCallId: id },
  ];
}
class Remote extends AbstractAgent {
  readonly inputs: RunAgentInput[] = [];
  constructor(
    private readonly respond: (
      input: RunAgentInput,
      index: number,
    ) => Observable<BaseEvent>,
  ) {
    super({ agentId: "remote" });
  }
  run(next: RunAgentInput) {
    this.inputs.push(next);
    return this.respond(next, this.inputs.length - 1);
  }
}
function snapshot(text = "revision-one"): LearnedSkillInvocation {
  return {
    catalog: `catalog ${text}`,
    tools: [load, read],
    execute: async () => text,
  };
}
async function events(
  middleware: RemoteLearnedSkillsMiddleware,
  remote: Remote,
  request = input,
) {
  return lastValueFrom(middleware.run(request, remote).pipe(toArray()));
}

describe("remote Automatic Learning delivery", () => {
  test("loads once, injects catalog and both tools, then resumes with the captured result", async () => {
    let acquisitions = 0;
    const remote = new Remote((_request, index) =>
      of(start, ...(index === 0 ? call() : []), finish),
    );
    const middleware = new RemoteLearnedSkillsMiddleware("bot", async () => {
      acquisitions += 1;
      return snapshot();
    });
    const output = await events(middleware, remote);
    expect(acquisitions).toBe(1);
    expect(remote.inputs).toHaveLength(2);
    for (const request of remote.inputs) {
      expect(request.context).toContainEqual({
        description: "OpenBot learned skills",
        value: "catalog revision-one",
      });
      expect(
        request.messages.some(
          (message) =>
            message.role === "system" &&
            message.content === "catalog revision-one",
        ),
      ).toBe(true);
      expect(request.tools.map((tool) => tool.name)).toEqual([
        load.name,
        read.name,
      ]);
      expect(request.forwardedProps).toEqual(input.forwardedProps);
    }
    expect(
      remote.inputs[1]?.messages.some(
        (message) =>
          message.role === "tool" && message.content === "revision-one",
      ),
    ).toBe(true);
    expect(
      output.filter((event) => event.type === EventType.TOOL_CALL_RESULT),
    ).toMatchObject([{ toolCallId: "call", content: "revision-one" }]);
    expect(
      output.filter((event) => event.type === EventType.RUN_STARTED),
    ).toHaveLength(1);
    expect(
      output.filter((event) => event.type === EventType.RUN_FINISHED),
    ).toHaveLength(1);
  });

  test("mixed learning and surface calls return the learning result without answering the surface", async () => {
    const remote = new Remote(() =>
      of(start, ...call(), ...call("draw_chart", "chart"), finish),
    );
    const output = await events(
      new RemoteLearnedSkillsMiddleware("bot", async () => snapshot()),
      remote,
    );
    expect(remote.inputs).toHaveLength(1);
    expect(
      output.filter((event) => event.type === EventType.TOOL_CALL_RESULT),
    ).toMatchObject([{ toolCallId: "call" }]);
    expect(output.at(-1)?.type).toBe(EventType.RUN_FINISHED);
  });

  test("never executes a learning call already answered by the remote", async () => {
    let executions = 0;
    const invocation = {
      ...snapshot(),
      execute: async () => {
        executions += 1;
        return "duplicate";
      },
    };
    const remote = new Remote(() =>
      of(
        start,
        ...call(),
        {
          type: EventType.TOOL_CALL_RESULT,
          toolCallId: "call",
          messageId: "result",
          role: "tool",
          content: "already answered",
        },
        finish,
      ),
    );
    await events(
      new RemoteLearnedSkillsMiddleware("bot", async () => invocation),
      remote,
    );
    expect(executions).toBe(0);
    expect(remote.inputs).toHaveLength(1);
  });

  test("rejects reserved tool collisions before contacting the remote", async () => {
    const remote = new Remote(() => of(start, finish));
    const output = await events(
      new RemoteLearnedSkillsMiddleware("bot", async () => snapshot()),
      remote,
      { ...input, tools: [load] },
    );
    expect(remote.inputs).toEqual([]);
    expect(output.at(-1)?.type).toBe(EventType.RUN_ERROR);
  });

  test("unconfigured delivery preserves the original run and never invents tools", async () => {
    const remote = new Remote(() => of(start, finish));
    expect(
      await events(
        new RemoteLearnedSkillsMiddleware("bot", async () => undefined),
        remote,
      ),
    ).toEqual([start, finish]);
    expect(remote.inputs).toEqual([input]);
  });

  test("denied acquisition stops before remote model work", async () => {
    const remote = new Remote(() => of(start, finish));
    const output = await events(
      new RemoteLearnedSkillsMiddleware("bot", async () => {
        throw new Error("delivery denied");
      }),
      remote,
    );
    expect(remote.inputs).toHaveLength(0);
    expect(output.at(-1)?.type).toBe(EventType.RUN_ERROR);
  });

  test("unsubscribe aborts an acquisition and never starts the remote", async () => {
    let signal: AbortSignal | undefined;
    let resolve: ((value: LearnedSkillInvocation) => void) | undefined;
    const remote = new Remote(() => of(start, finish));
    const middleware = new RemoteLearnedSkillsMiddleware(
      "bot",
      async (_agent, abortSignal) => {
        signal = abortSignal;
        return new Promise((done) => {
          resolve = done;
        });
      },
    );
    const subscription = middleware.run(input, remote).subscribe();
    subscription.unsubscribe();
    resolve?.(snapshot());
    await Promise.resolve();
    expect(signal?.aborted).toBe(true);
    expect(remote.inputs).toHaveLength(0);
  });
});

test("disabled learning waits for asynchronous remote events", async () => {
  const remote = new Remote(
    () =>
      new Observable((subscriber) => {
        const timer = setTimeout(() => {
          subscriber.next(start);
          subscriber.next(finish);
          subscriber.complete();
        }, 1);
        return () => clearTimeout(timer);
      }),
  );
  expect(
    await events(
      new RemoteLearnedSkillsMiddleware("bot", async () => undefined),
      remote,
    ),
  ).toEqual([start, finish]);
});

test("concurrent invocations retain independent snapshots through continuations", async () => {
  let version = 0;
  const middleware = new RemoteLearnedSkillsMiddleware("bot", async () =>
    snapshot(`revision-${++version}`),
  );
  const makeRemote = () =>
    new Remote((_request, index) =>
      of(start, ...(index === 0 ? call() : []), finish),
    );
  const first = makeRemote();
  const second = makeRemote();
  await Promise.all([events(middleware, first), events(middleware, second)]);
  expect(
    first.inputs[1]?.messages.some(
      (message) => message.role === "tool" && message.content === "revision-1",
    ),
  ).toBe(true);
  expect(
    second.inputs[1]?.messages.some(
      (message) => message.role === "tool" && message.content === "revision-2",
    ),
  ).toBe(true);
});

test("explicit learning interrupts resume with their matching IDs", async () => {
  const remote = new Remote((_request, index) =>
    index === 0
      ? of(start, ...call(), {
          ...finish,
          outcome: {
            type: "interrupt",
            interrupts: [
              { id: "interrupt", toolCallId: "call", reason: "client tool" },
            ],
          },
        })
      : of(start, finish),
  );
  await events(
    new RemoteLearnedSkillsMiddleware("bot", async () => snapshot()),
    remote,
  );
  expect(remote.inputs[1]?.resume).toEqual([
    { interruptId: "interrupt", status: "resolved", payload: "revision-one" },
  ]);
});

test("snapshot-only frameworks resume newly requested skill calls", async () => {
  const remote = new Remote((request, index) =>
    index === 0
      ? of(
          start,
          {
            type: EventType.MESSAGES_SNAPSHOT,
            messages: [
              ...request.messages,
              {
                id: "assistant",
                role: "assistant",
                toolCalls: [
                  {
                    id: "call",
                    type: "function",
                    function: {
                      name: load.name,
                      arguments: '{"skill_name":"refund"}',
                    },
                  },
                ],
              },
            ],
          },
          finish,
        )
      : of(start, finish),
  );
  const output = await events(
    new RemoteLearnedSkillsMiddleware("bot", async () => snapshot()),
    remote,
  );
  expect(remote.inputs).toHaveLength(2);
  expect(
    output.filter((event) => event.type === EventType.TOOL_CALL_RESULT),
  ).toMatchObject([{ toolCallId: "call", content: "revision-one" }]);
});

test("disabled delivery removes a catalog replayed in a remote message snapshot", async () => {
  const remote = new Remote(() => of(start, finish));
  await events(
    new RemoteLearnedSkillsMiddleware("bot", async () => undefined),
    remote,
    {
      ...input,
      messages: [
        {
          id: "openbot:learned-skills",
          role: "system",
          content: "old published catalog",
        },
        ...input.messages,
      ],
      context: [
        {
          description: "OpenBot learned skills",
          value: "old published catalog",
        },
      ],
    },
  );
  expect(remote.inputs[0]?.messages).toEqual(input.messages);
  expect(remote.inputs[0]?.context).toEqual([]);
});

for (const availability of ["disabled", "empty"]) {
  test(`${availability} delivery rejects a retained query's late learned tool call`, async () => {
    const remote = new Remote(() => of(start, ...call(), finish));
    const middleware = new RemoteLearnedSkillsMiddleware("bot", async () =>
      availability === "disabled"
        ? undefined
        : { ...snapshot(), catalog: "", tools: [] },
    );
    const output = await events(middleware, remote);
    expect(output.at(-1)).toMatchObject({
      type: EventType.RUN_ERROR,
      code: "OPENBOT_LEARNED_SKILLS_ERROR",
    });
    expect(
      output.filter((event) => event.type === EventType.RUN_FINISHED),
    ).toHaveLength(0);
    expect(remote.inputs).toHaveLength(1);
  });
}

test("disabled learning rejects a new snapshot-only learned call while preserving answered history", async () => {
  const oldMessages: RunAgentInput["messages"] = [
    ...input.messages,
    {
      id: "old-call",
      role: "assistant",
      toolCalls: [
        {
          id: "old",
          type: "function",
          function: { name: load.name, arguments: "{}" },
        },
      ],
    },
    {
      id: "old-result",
      role: "tool",
      toolCallId: "old",
      content: "Prior successful read",
    },
  ];
  const remote = new Remote((request) =>
    of(
      start,
      { type: EventType.MESSAGES_SNAPSHOT, messages: request.messages },
      finish,
    ),
  );
  const middleware = new RemoteLearnedSkillsMiddleware(
    "bot",
    async () => undefined,
  );
  expect(
    (await events(middleware, remote, { ...input, messages: oldMessages })).at(
      -1,
    )?.type,
  ).toBe(EventType.RUN_FINISHED);
  const late = new Remote((request) =>
    of(
      start,
      {
        type: EventType.MESSAGES_SNAPSHOT,
        messages: [
          ...request.messages,
          {
            id: "late",
            role: "assistant",
            toolCalls: [
              {
                id: "late",
                type: "function",
                function: { name: read.name, arguments: "{}" },
              },
            ],
          },
        ],
      },
      finish,
    ),
  );
  expect(
    (await events(middleware, late, { ...input, messages: oldMessages })).at(-1)
      ?.type,
  ).toBe(EventType.RUN_ERROR);
});
