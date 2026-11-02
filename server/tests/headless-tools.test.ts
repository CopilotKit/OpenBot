import { describe, expect, test } from "bun:test";
import {
  type AbstractAgent,
  type BaseEvent,
  EventType,
  HttpAgent,
  type RunAgentInput,
} from "@ag-ui/client";
import { HeadlessToolsMiddleware } from "@openbot/toolkit/headless-tools";
import { createTurnRunner, type RunnerLike } from "@openbot/toolkit/run-turn";
import { Observable } from "rxjs";
import { serverTurnAdmission } from "../src/agents/turn-admission";
import { parseApprovalContinuation } from "../src/approvals/types";
import type { AuditEventInput } from "../src/audit";
import { botSeat } from "../src/computer/computer-key";
import {
  ComputerStillStartingError,
  createComputerGateway,
} from "../src/computer/gateway";
import * as headless from "../src/computer/headless-tools";

const definition = {
  name: "computer_snapshot",
  description: "Snapshot the current browser page",
  parameters: { type: "object", properties: {} },
};

function remoteTurn(
  events: (input: RunAgentInput, index: number) => BaseEvent[],
) {
  const requests: RunAgentInput[] = [];
  const agent = new HttpAgent({
    agentId: "bot",
    url: "https://agent.example/ag-ui",
    fetch: async (_url, init) => {
      const request = JSON.parse(String(init.body)) as RunAgentInput;
      requests.push(request);
      return new Response(
        events(request, requests.length - 1)
          .map((event) => `data: ${JSON.stringify(event)}\n\n`)
          .join(""),
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  return { requests, agent };
}

function lifecycle(input: RunAgentInput, body: BaseEvent[]) {
  return [
    {
      type: EventType.RUN_STARTED,
      threadId: input.threadId,
      runId: input.runId,
    },
    ...body,
    {
      type: EventType.RUN_FINISHED,
      threadId: input.threadId,
      runId: input.runId,
    },
  ];
}

function toolCall(name = definition.name, args = "{}", id = "snapshot-call") {
  return [
    {
      type: EventType.TOOL_CALL_START,
      toolCallId: id,
      toolCallName: name,
      parentMessageId: `message-${id}`,
    },
    { type: EventType.TOOL_CALL_ARGS, toolCallId: id, delta: args },
    { type: EventType.TOOL_CALL_END, toolCallId: id },
  ];
}

function reply(text: string) {
  return [
    {
      type: EventType.TEXT_MESSAGE_START,
      messageId: "reply",
      role: "assistant",
    },
    { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "reply", delta: text },
    { type: EventType.TEXT_MESSAGE_END, messageId: "reply" },
  ];
}

function turnHarness(
  agent: AbstractAgent,
  toolsForTurn: (context: {
    ownerUserId: string;
    agentId: string;
    initiator: { kind: string; id?: string };
  }) => Promise<unknown[]>,
) {
  const persisted: BaseEvent[] = [];
  const lockCalls: string[] = [];
  const runner: RunnerLike = {
    run: ({ agent: selected, input }) =>
      new Observable((subscriber) => {
        selected
          .runAgent(input, {
            onEvent: ({ event }) => {
              persisted.push(event);
              subscriber.next(event);
            },
          })
          .then(
            () => subscriber.complete(),
            (error) => subscriber.error(error),
          );
      }),
    stop: async () => true,
  };
  const run = createTurnRunner({
    admission: serverTurnAdmission,
    intelligence: {
      getOrCreateThread: async () => undefined,
      getThreadMessages: async () => ({ messages: [] }),
      ɵacquireThreadLock: async () => {
        lockCalls.push("acquire");
      },
      ɵrenewThreadLock: async () => undefined,
      ɵcleanupThreadLock: async () => {
        lockCalls.push("cleanup");
      },
    },
    runner,
    buildAgentFor: async () => agent,
    toolsForTurn,
  });
  return {
    persisted,
    lockCalls,
    run: (
      continuation?: Parameters<
        ReturnType<typeof createTurnRunner>
      >[0]["continuation"],
    ) =>
      run({
        ownerUserId: "owner",
        routineId: "routine",
        agentId: "bot",
        threadId: "thread",
        instruction: "Inspect the browser",
        continuation,
      }),
  };
}

describe("headless AG-UI client tools", () => {
  test("an approved suspended HttpAgent turn resumes its exact call and state without replaying the action or adding a user instruction", async () => {
    const remote = remoteTurn((input) =>
      lifecycle(input, reply("The saved change is complete.")),
    );
    let executions = 0;
    const snapshot = parseApprovalContinuation({
      runId: "original-run",
      threadId: "thread",
      toolCallId: "approved-call",
      toolName: "computer_snapshot",
      args: {},
      messages: [
        {
          id: "original-request",
          role: "user",
          content: "Make this exact change",
        },
        {
          id: "original-call",
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: "approved-call",
              type: "function",
              function: { name: "computer_snapshot", arguments: "{}" },
            },
          ],
        },
      ],
      state: { selectedRecord: 42 },
      context: [{ description: "Selected order", value: "42" }],
      forwardedProps: { project: "original" },
    });
    const { run } = turnHarness(remote.agent, async () => [
      {
        definition,
        execute: async () => {
          executions += 1;
          return {};
        },
      },
    ]);
    await expect(
      run({
        snapshot,
        messageId: "approval:approval-id",
        result: { content: "saved" },
      }),
    ).resolves.toEqual({ replyText: "The saved change is complete." });
    expect(executions).toBe(0);
    expect(remote.requests).toHaveLength(1);
    expect(remote.requests[0]?.messages).toEqual([
      ...snapshot.messages,
      {
        id: "approval:approval-id",
        role: "tool",
        toolCallId: "approved-call",
        content: "saved",
      },
    ]);
    expect(remote.requests[0]?.state).toEqual(snapshot.state);
    expect(remote.requests[0]?.context).toEqual(snapshot.context);
    expect(remote.requests[0]?.forwardedProps).toEqual(snapshot.forwardedProps);
    expect(remote.requests[0]?.resume).toEqual([
      { interruptId: "approved-call", status: "resolved", payload: "saved" },
    ]);
  });
  test("a scheduled HttpAgent turn executes the tool and persists its result before remote continuation", async () => {
    const remote = remoteTurn((input, index) =>
      lifecycle(input, index === 0 ? toolCall() : reply("Found a real page.")),
    );
    const executions: string[] = [];
    const contexts: unknown[] = [];
    const { run, persisted, lockCalls } = turnHarness(
      remote.agent,
      async (context) => {
        contexts.push(context);
        return [
          {
            definition,
            execute: async (
              _args: unknown,
              context: { toolCallId: string },
            ) => {
              executions.push(context.toolCallId);
              return {
                snapshotId: 7,
                title: "Orders",
                elements: [{ ref: "e1", role: "button", name: "Open" }],
              };
            },
          },
        ];
      },
    );

    await expect(run()).resolves.toEqual({ replyText: "Found a real page." });
    expect(contexts).toEqual([
      {
        ownerUserId: "owner",
        agentId: "bot",
        initiator: { kind: "routine", id: "routine" },
        threadId: "thread",
        runId: expect.any(String),
      },
    ]);
    expect(executions).toEqual(["snapshot-call"]);
    expect(remote.requests).toHaveLength(2);
    expect(remote.requests[0]?.tools).toContainEqual(definition);
    expect(remote.requests[1]?.messages).toContainEqual(
      expect.objectContaining({
        role: "tool",
        toolCallId: "snapshot-call",
        content: expect.stringContaining('"snapshotId":7'),
      }),
    );
    expect(
      persisted.filter((event) => event.type === EventType.TOOL_CALL_RESULT),
    ).toHaveLength(1);
    expect(
      persisted.filter((event) => event.type === EventType.RUN_STARTED),
    ).toHaveLength(1);
    expect(
      persisted.filter((event) => event.type === EventType.RUN_FINISHED),
    ).toHaveLength(1);
    expect(lockCalls).toEqual(["acquire", "cleanup"]);
  });
});

function computerHarness(deny: string[] = []) {
  const audit: AuditEventInput[] = [];
  const received: { path: string; body?: unknown }[] = [];
  const gateway = createComputerGateway({
    provider: {
      name: "test",
      isolation: "per-person",
      locate: async () => "http://computer:4100",
      status: async (seat) => ({ botId: seat.botId, state: "ready" }),
      list: async () => [],
      stop: async () => ({ wasRunning: true }),
      reset: async () => ({ cleared: true }),
    },
    auditStore: {
      insert: async (event) => {
        audit.push(event);
      },
    },
    policy: () => ({ mode: "enforce", allow: ["true"], deny }),
    fetchImpl: async (url, init) => {
      const path = new URL(String(url)).pathname;
      received.push({
        path,
        ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
      });
      const outputs: { [path: string]: object } = {
        "/snapshot": {
          snapshotId: 7,
          url: "https://example.com",
          title: "Orders",
          truncated: false,
          elements: [{ ref: "e1", role: "button", name: "Open" }],
        },
        "/navigate": {
          url: "https://example.com",
          title: "Orders",
          text: "Orders",
          truncated: false,
          elapsedMs: 1,
        },
        "/click": { action: "click", url: "https://example.com", elapsedMs: 1 },
        "/exec": {
          command: "pwd",
          exitCode: 0,
          stdout: "/workspace",
          stderr: "",
          elapsedMs: 1,
          timedOut: false,
          truncated: false,
        },
        "/files/list": {
          path: "",
          entries: [{ path: "notes.md", kind: "file", bytes: 5 }],
          truncated: false,
        },
        "/files/read": {
          path: "notes.md",
          text: "notes",
          bytes: 5,
          truncated: false,
        },
        "/files/write": { path: "notes.md", bytes: 5, appended: false },
        "/control/request": {
          holder: "bot",
          requested: true,
          transitioning: false,
          since: "now",
          resumeSnapshotRequired: false,
          recoveryRequired: false,
          request: {
            id: "durable-handoff",
            status: "waiting",
            reason: "Sign in",
            source: "model",
            createdAt: "now",
            updatedAt: "now",
          },
        },
      };
      if (!outputs[path])
        throw new Error(`Unexpected computer request ${path}`);
      return Response.json(outputs[path]);
    },
  });
  return { gateway, audit, received };
}

test("scheduled computer actions carry the owner and routine into both policy and audit", async () => {
  const { gateway, received, audit } = computerHarness([
    'initiator.kind == "routine" && intent == "run_command"',
  ]);
  const actor = {
    id: "owner",
    userId: "owner",
    initiator: { kind: "routine" as const, id: "routine" },
  };
  await expect(
    gateway.runCommand(botSeat("bot"), actor, { command: "pwd" }),
  ).rejects.toThrow();
  expect(received.some((call) => call.path === "/exec")).toBe(false);
  expect(audit).toContainEqual(
    expect.objectContaining({
      actorUserId: "owner",
      initiator: actor.initiator,
      eventType: "computer.action_refused",
    }),
  );
});

/**
 * A cold start that outlasts the wait reaches the model as an answer it can act on.
 *
 * Thrown, it was one more error string; the model apologised and gave up on a computer that was
 * seconds from ready. And a click used to wait for the start twice, once to learn the run and again
 * to send, so it is also pinned that the wait happens once.
 */
test("a computer still starting answers 'not performed, try again' rather than throwing, after one wait", async () => {
  let locates = 0;
  const audit: AuditEventInput[] = [];
  const gateway = createComputerGateway({
    provider: {
      name: "test",
      isolation: "per-person",
      locate: async () => {
        locates++;
        throw new ComputerStillStartingError();
      },
      status: async (seat) => ({ botId: seat.botId, state: "starting" }),
      list: async () => [],
      stop: async () => ({ wasRunning: false }),
      reset: async () => ({ cleared: false }),
    },
    auditStore: {
      insert: async (event) => {
        audit.push(event);
      },
    },
    policy: () => ({ mode: "enforce", allow: ["true"], deny: [] }),
    fetchImpl: (async () => {
      throw new Error("nothing should reach the computer");
    }) as unknown as typeof fetch,
  });
  const tools = headless.createHeadlessComputerTools({
    gateway,
    seat: botSeat("bot"),
    actor: { id: "owner", userId: "owner" },
  });
  const invoke = (name: string, args: unknown) => {
    const tool = tools.find((candidate) => candidate.definition.name === name);
    if (!tool) throw new Error(`Missing ${name}`);
    return tool.execute(args, {
      toolCallId: name,
      signal: new AbortController().signal,
    });
  };

  const navigated = await invoke("computer_navigate", {
    url: "https://example.com",
  });
  expect(navigated).toMatchObject({
    ok: false,
    starting: true,
    notPerformed: true,
  });
  expect(String((navigated as { reason?: string }).reason)).toContain(
    "not performed",
  );

  locates = 0;
  const clicked = await invoke("computer_click", { ref: "e1", snapshotId: 7 });
  expect(clicked).toMatchObject({ ok: false, starting: true });
  expect(locates).toBe(1);
  // Still on the trail: allowed, then the failure that says it did not happen.
  expect(audit.map((event) => event.eventType)).toContain(
    "computer.action_failed",
  );
});

test("the headless computer adapter executes shipped browser, command, and file tools through the gateway", async () => {
  expect(typeof headless.createHeadlessComputerTools).toBe("function");
  const { gateway, received, audit } = computerHarness();
  const tools = headless.createHeadlessComputerTools({
    gateway,
    seat: botSeat("bot"),
    actor: {
      id: "owner",
      userId: "owner",
      initiator: { kind: "routine", id: "routine" },
    },
  });
  const invoke = async (name: string, args: unknown) => {
    const tool = tools.find((tool) => tool.definition.name === name);
    if (!tool) throw new Error(`Missing ${name}`);
    return tool.execute(args, {
      toolCallId: name,
      signal: new AbortController().signal,
    });
  };
  await invoke("computer_snapshot", {});
  await invoke("computer_navigate", { url: "https://example.com" });
  await invoke("computer_click", { ref: "e1", snapshotId: 7 });
  await invoke("computer_run_command", { command: "pwd" });
  await invoke("computer_list_files", {});
  await invoke("computer_read_file", { path: "notes.md" });
  await invoke("computer_write_file", { path: "notes.md", contents: "notes" });
  expect(received.map((call) => call.path)).toEqual([
    "/snapshot",
    "/navigate",
    "/click",
    "/exec",
    "/files/list",
    "/files/read",
    "/files/write",
  ]);
  expect(
    audit.filter((event) => event.eventType === "computer.action_allowed"),
  ).toHaveLength(6);
  for (const event of audit)
    expect(event).toMatchObject({
      actorUserId: "owner",
      initiator: { kind: "routine", id: "routine" },
      targetId: "bot",
    });
  const count = received.length;
  await expect(
    invoke("computer_click", { ref: "e1", snapshotId: "7" }),
  ).rejects.toThrow();
  await expect(
    invoke("computer_run_command", { command: "pwd", botId: "victim" }),
  ).rejects.toThrow();
  expect(received).toHaveLength(count);
});

test("an unattended remote computer run snapshots, clicks, runs commands and saves files with persisted results", async () => {
  const { gateway, audit } = computerHarness();
  const steps = [
    { name: "computer_snapshot", args: {} },
    { name: "computer_navigate", args: { url: "https://example.com" } },
    { name: "computer_click", args: { ref: "e1", snapshotId: 7 } },
    { name: "computer_run_command", args: { command: "pwd" } },
    { name: "computer_list_files", args: {} },
    { name: "computer_read_file", args: { path: "notes.md" } },
    {
      name: "computer_write_file",
      args: { path: "notes.md", contents: "notes" },
    },
  ];
  const remote = remoteTurn((input, index) => {
    const step = steps[index];
    return lifecycle(
      input,
      step
        ? toolCall(step.name, JSON.stringify(step.args), `call-${index}`)
        : reply("Inspected and saved the notes."),
    );
  });
  const { run, persisted } = turnHarness(remote.agent, async () =>
    headless.createHeadlessComputerTools({
      gateway,
      seat: botSeat("bot"),
      actor: {
        id: "owner",
        userId: "owner",
        initiator: { kind: "routine", id: "routine" },
      },
    }),
  );
  await expect(run()).resolves.toEqual({
    replyText: "Inspected and saved the notes.",
  });
  expect(remote.requests).toHaveLength(8);
  expect(
    remote.requests[7]?.messages.filter((message) => message.role === "tool"),
  ).toHaveLength(7);
  expect(
    persisted.filter((event) => event.type === EventType.TOOL_CALL_RESULT),
  ).toHaveLength(7);
  expect(
    audit.filter((event) => event.eventType === "computer.action_allowed"),
  ).toHaveLength(6);
});

test("remote backend tool results are persisted without executing the client tool a second time", async () => {
  const remote = remoteTurn((input) =>
    lifecycle(input, [
      ...toolCall(),
      {
        type: EventType.TOOL_CALL_RESULT,
        toolCallId: "snapshot-call",
        messageId: "backend-result",
        role: "tool",
        content: "Backend handled it.",
      },
      ...reply("The backend handled it."),
    ]),
  );
  let executions = 0;
  const { run, persisted } = turnHarness(remote.agent, async () => [
    {
      definition,
      execute: async () => {
        executions += 1;
        return "Local";
      },
    },
  ]);
  await expect(run()).resolves.toEqual({
    replyText: "The backend handled it.",
  });
  expect(executions).toBe(0);
  expect(remote.requests).toHaveLength(1);
  expect(
    persisted.filter((event) => event.type === EventType.TOOL_CALL_RESULT),
  ).toHaveLength(1);
});

test("a computer tool the caller offers is left to the caller when OpenBot adds plugin tools beside it", async () => {
  const remote = remoteTurn((input) =>
    lifecycle(
      input,
      toolCall("computer_navigate", '{"url":"https://example.com"}'),
    ),
  );
  let executions = 0;
  const middleware = new HeadlessToolsMiddleware([
    {
      definition: {
        name: "web_search",
        description: "Search the public web",
        parameters: { type: "object", properties: {} },
      },
      execute: async () => {
        executions += 1;
        return "Results";
      },
    },
  ]);
  const events: BaseEvent[] = [];
  await new Promise<void>((resolve, reject) =>
    middleware
      .run(
        {
          threadId: "thread",
          runId: "run",
          messages: [],
          state: {},
          context: [],
          forwardedProps: {},
          tools: [
            {
              name: "computer_navigate",
              description: "Open a page in the Bot's browser",
              parameters: { type: "object", properties: {} },
            },
          ],
        },
        remote.agent,
      )
      .subscribe({
        next: (event) => events.push(event),
        error: reject,
        complete: resolve,
      }),
  );
  expect(executions).toBe(0);
  expect(remote.requests).toHaveLength(1);
  expect(
    events.filter((event) => event.type === EventType.TOOL_CALL_RESULT),
  ).toHaveLength(0);
  expect(events.at(-1)?.type).toBe(EventType.RUN_FINISHED);
});

test("unknown computer tool calls become error results rather than commands", async () => {
  const remote = remoteTurn((input, index) =>
    lifecycle(
      input,
      index === 0
        ? toolCall("computer_steal", "{}")
        : reply("That tool is unavailable."),
    ),
  );
  let executions = 0;
  const { run, persisted } = turnHarness(remote.agent, async () => [
    {
      definition,
      execute: async () => {
        executions += 1;
        return "Local";
      },
    },
  ]);
  await run();
  expect(executions).toBe(0);
  expect(
    persisted.filter((event) => event.type === EventType.TOOL_CALL_RESULT),
  ).toMatchObject([{ content: expect.stringContaining("unavailable") }]);
  expect(remote.requests[1]?.messages).toContainEqual(
    expect.objectContaining({
      role: "tool",
      error: expect.stringContaining("unavailable"),
    }),
  );
});

test("human help creates a durable suspension, persists the waiting event, and releases the thread lock", async () => {
  const { gateway, audit } = computerHarness();
  const remote = remoteTurn((input) =>
    lifecycle(
      input,
      toolCall("computer_request_help", '{"reason":"Sign in"}', "help-call"),
    ),
  );
  const { run, persisted, lockCalls } = turnHarness(remote.agent, async () =>
    headless.createHeadlessComputerTools({
      gateway,
      seat: botSeat("bot"),
      actor: {
        id: "owner",
        userId: "owner",
        initiator: { kind: "routine", id: "routine" },
      },
    }),
  );
  await expect(run()).rejects.toMatchObject({
    name: "HeadlessToolSuspension",
    waiting: {
      kind: "computer_handoff",
      requestId: "durable-handoff",
      botId: "bot",
      toolCallId: "help-call",
    },
  });
  expect(remote.requests).toHaveLength(1);
  expect(
    persisted.filter((event) => event.type === EventType.CUSTOM),
  ).toMatchObject([
    {
      name: "openbot.headless.waiting",
      value: { requestId: "durable-handoff" },
    },
  ]);
  expect(
    persisted.filter((event) => event.type === EventType.TOOL_CALL_RESULT),
  ).toHaveLength(0);
  expect(audit).toContainEqual(
    expect.objectContaining({
      eventType: "computer.help_requested",
      initiator: { kind: "routine", id: "routine" },
    }),
  );
  expect(lockCalls).toEqual(["acquire", "cleanup"]);
});
