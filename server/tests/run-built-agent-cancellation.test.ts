import { expect, spyOn, test } from "bun:test";
import { EventType, HttpAgent } from "@ag-ui/client";
import type { AbstractAgent, BaseEvent, RunAgentInput } from "@ag-ui/client";
import { LLMock } from "@copilotkit/aimock";
import { BuiltInAgent } from "@copilotkit/runtime/v2";
import { z } from "zod";
import {
  buildAgents,
  type HandoffForRun,
  type RuntimeModel,
  type ToolSelection,
} from "../src/copilot";
import type { GrantedTool } from "../src/plugins/tools";
import { createModelCompleter } from "../src/routing/model";

const model: RuntimeModel = { provider: "openai", defaultModel: "gpt-5.5" };
const input: RunAgentInput = {
  threadId: "cancellation-fixture-thread",
  runId: "cancellation-fixture-run",
  messages: [
    { id: "user", role: "user", content: "Read the fixture document." },
  ],
  tools: [],
  context: [],
  state: {},
  forwardedProps: {},
};
const skills = [
  {
    slug: "read",
    title: "Read",
    summary: "Read a fixture.",
    tools: ["fixture/read"],
  },
];

function deferred<T>() {
  return Promise.withResolvers<T>();
}

async function bounded<T>(
  promise: Promise<T>,
  boundary = "operation",
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Fixture ${boundary} timed out`)),
          1500,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function observe(agent: AbstractAgent) {
  const events: BaseEvent[] = [];
  const settled = deferred<void>();
  let completions = 0;
  const subscription = agent.run(input).subscribe({
    next: (event) => events.push(event),
    error: settled.reject,
    complete: () => {
      completions++;
      settled.resolve();
    },
  });
  return {
    events,
    settled: settled.promise,
    subscription,
    completions: () => completions,
  };
}

async function fixture() {
  const llm = new LLMock();
  const originalBase = process.env.OPENAI_BASE_URL;
  process.env.OPENAI_BASE_URL = await llm.start();
  llm.onMessage(/.*/, { content: "Fixture completed." });
  let executions = 0;
  const granted: GrantedTool[] = [
    {
      ref: "fixture/read",
      name: "mcp__fixture__read",
      description: "Read a fixture",
      parameters: z.object({}),
      execute: async () => {
        executions++;
        return "fixture";
      },
    },
  ];
  return {
    llm,
    executions: () => executions,
    async agent(
      choose?: ToolSelection["choose"],
      handoff?: HandoffForRun,
      record?: ToolSelection["record"],
    ) {
      const agents = await buildAgents(
        [
          {
            id: "fixture",
            name: "Fixture",
            type: "built_in",
            systemPrompt: "Answer the fixture.",
          },
        ],
        model,
        "synthetic-fixture-key",
        undefined,
        async () => granted,
        undefined,
        undefined,
        undefined,
        choose
          ? { choose, loadSkills: async () => skills, floor: 0, record }
          : undefined,
        undefined,
        handoff,
      );
      if (!agents.fixture) throw new Error("Fixture agent missing");
      return agents.fixture.clone();
    },
    async [Symbol.asyncDispose]() {
      if (originalBase === undefined) delete process.env.OPENAI_BASE_URL;
      else process.env.OPENAI_BASE_URL = originalBase;
      await llm.stop();
    },
  };
}

for (const phase of ["selector", "handoff"] as const) {
  for (const outcome of ["resolve", "reject"] as const) {
    test(`Stop during ${phase} blocks a late ${outcome} and completes once`, async () => {
      await using f = await fixture();
      const gate = deferred<void>();
      const entered = deferred<void>();
      let records = 0;
      const wait = async () => {
        entered.resolve();
        await gate.promise;
      };
      const agent = await f.agent(
        phase === "selector"
          ? async () => {
              await wait();
              return '{"skills":["read"]}';
            }
          : undefined,
        phase === "handoff"
          ? async () => {
              await wait();
              return [];
            }
          : undefined,
        async () => {
          records++;
        },
      );
      const run = observe(agent);
      try {
        await bounded(entered.promise);
        agent.abortRun();
        if (outcome === "resolve") gate.resolve();
        else gate.reject(new Error("Synthetic late build rejection"));
        await bounded(run.settled);
        // Drain the released build's continuation, not merely the abort notification.
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(f.llm.getRequests()).toHaveLength(0);
        expect(run.events).toHaveLength(0);
        expect(f.executions()).toBe(0);
        expect(records).toBe(0);
        expect(run.completions()).toBe(1);
      } finally {
        gate.resolve();
        run.subscription.unsubscribe();
      }
    });
  }
}

/** A real selector connection held by this test. Final requests go only to LLMock. */
async function selectorEndpoint(
  llm: LLMock,
  hold: "selector" | "final" = "selector",
) {
  const entered = deferred<void>();
  const closed = deferred<void>();
  const release = deferred<void>();
  const handled = deferred<void>();
  let selectorRequests = 0;
  let finalRequests = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const body = await request.text();
      const selector = body.includes("You choose which capabilities to load");
      if (selector) selectorRequests++;
      else finalRequests++;
      if (selector === (hold === "selector")) {
        request.signal.addEventListener("abort", () => closed.resolve(), {
          once: true,
        });
        entered.resolve();
        await release.promise;
        handled.resolve();
        return Response.json({
          choices: [{ message: { content: '{"skills":["read"]}' } }],
        });
      }
      return fetch(`${llm.url}${new URL(request.url).pathname}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
    },
  });
  return {
    url: `${server.url.origin}/v1`,
    entered,
    closed,
    release,
    handled,
    counts: () => ({ selectorRequests, finalRequests }),
    async [Symbol.asyncDispose]() {
      release.resolve();
      await server.stop(true);
    },
  };
}

test("Stop cancels the production selector HTTP connection before a late reply can start the final model", async () => {
  await using f = await fixture();
  await using endpoint = await selectorEndpoint(f.llm);
  process.env.OPENAI_BASE_URL = endpoint.url;
  let records = 0;
  const agent = await f.agent(
    createModelCompleter({
      model,
      resolveApiKey: async () => "synthetic-fixture-key",
    }),
    undefined,
    async () => {
      records++;
    },
  );
  const run = observe(agent);
  try {
    await bounded(endpoint.entered.promise, "request arrival");
    agent.abortRun();
    // The server observes the request abort while its response is still held.
    await bounded(endpoint.closed.promise, "server request abort");
    await bounded(run.settled);
    endpoint.release.resolve();
    await bounded(endpoint.handled.promise, "late response handler");
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(endpoint.counts()).toEqual({
      selectorRequests: 1,
      finalRequests: 0,
    });
    expect(f.llm.getRequests()).toHaveLength(0);
    expect(records).toBe(0);
    expect(run.events).toHaveLength(0);
    expect(run.completions()).toBe(1);
    console.log(
      JSON.stringify({
        proof: "production-selector-HTTP-stop",
        ...endpoint.counts(),
        serverRequestAbortedBeforeRelease: true,
        selectionRecords: records,
        completions: run.completions(),
      }),
    );
  } finally {
    endpoint.release.resolve();
    run.subscription.unsubscribe();
  }
});

test("Stop after the build still aborts the inner agent and its model HTTP connection", async () => {
  await using f = await fixture();
  await using endpoint = await selectorEndpoint(f.llm, "final");
  process.env.OPENAI_BASE_URL = endpoint.url;
  const agent = await f.agent(undefined, async () => []);
  const abort = spyOn(BuiltInAgent.prototype, "abortRun");
  const run = observe(agent);
  try {
    await bounded(endpoint.entered.promise, "request arrival");
    agent.abortRun();
    await bounded(endpoint.closed.promise, "server request abort");
    await bounded(run.settled);
    expect(abort).toHaveBeenCalledTimes(1);
    expect(endpoint.counts()).toEqual({
      selectorRequests: 0,
      finalRequests: 1,
    });
    expect(run.completions()).toBe(1);
    console.log(
      JSON.stringify({
        proof: "post-build-model-HTTP-stop",
        ...endpoint.counts(),
        serverRequestAbortedBeforeRelease: true,
        innerAborts: abort.mock.calls.length,
      }),
    );
  } finally {
    endpoint.release.resolve();
    await bounded(endpoint.handled.promise, "late response handler");
    run.subscription.unsubscribe();
    abort.mockRestore();
  }
});

test("an aborted pending run does not cancel its clone or the next run on the same wrapper", async () => {
  await using f = await fixture();
  const gate = deferred<string | null>();
  let selections = 0;
  const agent = await f.agent(async () => {
    selections++;
    return selections === 1 ? gate.promise : '{"skills":["read"]}';
  });
  const first = observe(agent);
  const clone = agent.clone();
  try {
    agent.abortRun();
    await bounded(first.settled);
    // Finish the next run before the cancelled build resolves.
    for (const next of [agent, clone]) {
      next.setMessages(input.messages);
      await bounded(next.runAgent());
      expect(next.messages.at(-1)).toMatchObject({
        role: "assistant",
        content: "Fixture completed.",
      });
    }
    gate.resolve('{"skills":["read"]}');
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(f.llm.getRequests()).toHaveLength(2);
    expect(first.events).toHaveLength(0);
    expect(first.completions()).toBe(1);
    expect(selections).toBe(3);
  } finally {
    gate.resolve(null);
    first.subscription.unsubscribe();
  }
});

async function remoteSseEndpoint() {
  const entered = deferred<void>();
  const aborted = deferred<void>();
  const release = deferred<void>();
  const finished = deferred<void>();
  let requests = 0;
  const bodies: RunAgentInput[] = [];
  const encoder = new TextEncoder();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      requests++;
      const body = (await request.clone().json()) as RunAgentInput;
      bodies.push(body);
      request.signal.addEventListener("abort", () => aborted.resolve(), {
        once: true,
      });
      entered.resolve();
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({
                type: EventType.RUN_STARTED,
                threadId: body.threadId,
                runId: body.runId,
                input: body,
              })}\n\n`,
            ),
          );
          await release.promise;
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({
                type: EventType.RUN_FINISHED,
                threadId: body.threadId,
                runId: body.runId,
                result: "released",
              })}\n\n`,
            ),
          );
          controller.close();
          finished.resolve();
        },
        cancel() {
          aborted.resolve();
        },
      });
      return new Response(stream, {
        headers: { "content-type": "text/event-stream" },
      });
    },
  });
  return {
    server,
    entered,
    aborted,
    release,
    finished,
    url: server.url.href,
    counts: () => ({ requests, bodies: [...bodies] }),
    async [Symbol.asyncDispose]() {
      release.resolve();
      await server.stop(true);
    },
  };
}

type RemoteSseEndpoint = Awaited<ReturnType<typeof remoteSseEndpoint>>;

async function resolvesWithin<T>(
  promise: Promise<T>,
  ms: number,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function runRemoteAndStop(
  label: string,
  agent: AbstractAgent,
  endpoint: RemoteSseEndpoint,
) {
  const started = deferred<void>();
  const run = agent
    .runAgent(input, {
      onRunStartedEvent() {
        started.resolve();
      },
    })
    .catch((error: unknown) => ({
      error: String(error instanceof Error ? error.message : error),
    }));
  await bounded(endpoint.entered.promise, `${label} request arrival`);
  await bounded(started.promise, `${label} RUN_STARTED event`);
  const closedBeforeStop = await resolvesWithin(endpoint.aborted.promise, 100);
  agent.abortRun();
  const closedAfterStop = await resolvesWithin(endpoint.aborted.promise, 1000);
  endpoint.release.resolve();
  await Promise.race([run, resolvesWithin(endpoint.finished.promise, 1500)]);
  return { closedBeforeStop, closedAfterStop, ...endpoint.counts() };
}

test("Stop aborts a production wrapped remote AG-UI HTTP stream", async () => {
  const never = Promise.withResolvers<void>();
  expect(await resolvesWithin(never.promise, 20)).toBe(false);
  expect(await resolvesWithin(Promise.resolve(), 1500)).toBe(true);

  await using directEndpoint = await remoteSseEndpoint();
  const direct = await runRemoteAndStop(
    "direct remote",
    new HttpAgent({ url: directEndpoint.url }),
    directEndpoint,
  );
  expect(direct.closedBeforeStop).toBe(false);
  expect(direct.closedAfterStop).toBe(true);
  expect(direct.requests).toBe(1);
  expect(direct.bodies[0]?.runId).toBe(input.runId);
  expect(typeof direct.bodies[0]?.threadId).toBe("string");

  await using wrappedEndpoint = await remoteSseEndpoint();
  const agents = await buildAgents(
    [
      {
        id: "remote-fixture",
        name: "Remote Fixture",
        type: "remote_ag_ui",
        endpoint: wrappedEndpoint.url,
        standingMessage: {
          id: "standing-role:remote-fixture",
          role: "system",
          content: "You are Remote Fixture.",
        },
      },
    ],
    model,
    "unused-synthetic-key",
  );
  const wrapped = agents["remote-fixture"];
  if (!wrapped) throw new Error("remote fixture not built");

  const wrappedResult = await runRemoteAndStop(
    "production wrapped remote",
    wrapped,
    wrappedEndpoint,
  );
  expect(wrappedResult.closedBeforeStop).toBe(false);
  expect(wrappedResult.closedAfterStop).toBe(true);
  expect(wrappedResult.requests).toBe(1);
  expect(wrappedResult.bodies[0]?.runId).toBe(input.runId);
  expect(typeof wrappedResult.bodies[0]?.threadId).toBe("string");
  expect(wrappedResult.bodies[0]?.messages[0]).toMatchObject({
    id: "standing-role:remote-fixture",
    role: "system",
  });
  console.log(
    JSON.stringify({
      proof: "production-wrapped-remote-http-stop",
      direct: {
        closedBeforeStop: direct.closedBeforeStop,
        closedAfterStop: direct.closedAfterStop,
        requests: direct.requests,
      },
      wrapped: {
        closedBeforeStop: wrappedResult.closedBeforeStop,
        closedAfterStop: wrappedResult.closedAfterStop,
        requests: wrappedResult.requests,
      },
    }),
  );
});
