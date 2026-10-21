import { expect, test } from "bun:test";
import {
  type BaseEvent,
  EventType,
  HttpAgent,
  type RunAgentInput,
} from "@ag-ui/client";
import { HeadlessToolsMiddleware } from "../src/headless-tools";

function remoteTurn(events: (input: RunAgentInput, index: number) => BaseEvent[]) {
  const requests: RunAgentInput[] = [];
  const agent = new HttpAgent({
    agentId: "bot",
    url: "https://agent.example/ag-ui",
    fetch: async (_url, init) => {
      const request = JSON.parse(String(init?.body)) as RunAgentInput;
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

function lifecycle(input: RunAgentInput, body: BaseEvent[]): BaseEvent[] {
  return [
    { type: EventType.RUN_STARTED, threadId: input.threadId, runId: input.runId },
    ...body,
    { type: EventType.RUN_FINISHED, threadId: input.threadId, runId: input.runId },
  ];
}

function toolCall(name: string, id: string): BaseEvent[] {
  return [
    {
      type: EventType.TOOL_CALL_START,
      toolCallId: id,
      toolCallName: name,
      parentMessageId: `message-${id}`,
    },
    { type: EventType.TOOL_CALL_ARGS, toolCallId: id, delta: "{}" },
    { type: EventType.TOOL_CALL_END, toolCallId: id },
  ];
}

function reply(text: string): BaseEvent[] {
  return [
    { type: EventType.TEXT_MESSAGE_START, messageId: "reply", role: "assistant" },
    { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "reply", delta: text },
    { type: EventType.TEXT_MESSAGE_END, messageId: "reply" },
  ];
}

function input(tools: RunAgentInput["tools"]): RunAgentInput {
  return {
    threadId: "thread",
    runId: "run",
    messages: [],
    state: {},
    tools,
    context: [],
    forwardedProps: {},
  } as RunAgentInput;
}

async function collect(middleware: HeadlessToolsMiddleware, runInput: RunAgentInput, agent: HttpAgent) {
  const events: BaseEvent[] = [];
  await new Promise<void>((resolve, reject) =>
    middleware.run(runInput, agent).subscribe({
      next: (event) => events.push(event),
      error: reject,
      complete: resolve,
    }),
  );
  return events;
}

test("a computer tool the caller offers passes through for the caller to execute", async () => {
  const remote = remoteTurn((runInput, _index) =>
    lifecycle(runInput, [
      ...toolCall("computer_navigate", "nav-call"),
      ...reply("Opening the page."),
    ]),
  );
  const middleware = new HeadlessToolsMiddleware([]);
  const events = await collect(
    middleware,
    input([
      {
        name: "computer_navigate",
        description: "Open a page in the person's browser",
        parameters: { type: "object", properties: {} },
      },
    ]),
    remote.agent,
  );

  expect(events.map((event) => event.type)).toContain(EventType.RUN_FINISHED);
  expect(events.map((event) => event.type)).not.toContain(
    EventType.TOOL_CALL_RESULT,
  );
  expect(remote.requests).toHaveLength(1);
});

test("a computer tool the caller did not offer still gets the governed refusal", async () => {
  const remote = remoteTurn((runInput, index) =>
    lifecycle(
      runInput,
      index === 0
        ? toolCall("computer_steal", "steal-call")
        : reply("That tool is unavailable."),
    ),
  );
  const middleware = new HeadlessToolsMiddleware([]);
  await collect(middleware, input([]), remote.agent);

  expect(remote.requests).toHaveLength(2);
  expect(remote.requests[1]?.messages).toContainEqual(
    expect.objectContaining({
      role: "tool",
      error: expect.stringContaining("unavailable"),
    }),
  );
});
