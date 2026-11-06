import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  AbstractAgent,
  type BaseEvent,
  EventType,
  type RunAgentInput,
} from "@ag-ui/client";
import { LLMock } from "@copilotkit/aimock";
import {
  type CopilotKitIntelligence,
  IntelligenceAgentRunner,
} from "@copilotkit/runtime/v2";
import {
  AG_UI_CHANNEL_EVENT,
  type LambdaSendOptions,
} from "@copilotkit/shared";
import { createIntelligenceThreadLock } from "@openbot/toolkit/copilotkit/thread-lock";
import { createTurnRunner } from "@openbot/toolkit/run-turn";
import type { ServerWebSocket } from "bun";
import { Observable, type Subscriber } from "rxjs";
import { createActorAgentResolver } from "../src/agents/agent-resolver";
import { createAgentFetch } from "../src/agents/endpoint";
import { createHandoffDelivery } from "../src/agents/handoff-delivery";
import { createSubagents } from "../src/agents/subagent";
import { PERSON_INITIATOR } from "../src/audit";
import { loadConfig } from "../src/config";
import { mountCopilotRuntime, registeredAgentFromRow } from "../src/copilot";
import { createIntelligenceClient } from "../src/intelligence-client";
import { createProductTelemetry } from "../src/telemetry/product";
import {
  productHandoffInput,
  productHeadlessBoundary,
} from "../src/telemetry/product-boundaries";
import { testEnvironment } from "./support/environment";

/**
 * A run OpenBot knows was stopped ends, in OpenBot's own product telemetry, as the contract's
 * `cancelled` (or `timeout`, for a turn's deadline) with `failure_category` `none`. Intelligence's
 * run summary already reads it so. A run that ends with no terminal event and no stop still reads
 * `missing_terminal`, and a lost lock is not a cancellation.
 *
 * Every run goes the real way: a browser run through the handler `mountCopilotRuntime` returns, a
 * headless turn and a Bot-to-Bot hop through the real Intelligence runner. The Intelligence platform
 * is the fake, REST and the runner's Phoenix channel on 127.0.0.1, and it relays a person's Stop to
 * the runner as the gateway does. Models are stand-ins: a slow model for the built-in Bot, a Bot
 * endpoint that drops its stream, and a Bot that works until it is stopped.
 */

const sent: LambdaSendOptions[] = [];
const delivered: { runId?: string; type?: string }[] = [];
const joined = new Map<
  string,
  { socket: ServerWebSocket<unknown>; joinRef: string | null }
>();
let platform: ReturnType<typeof Bun.serve>;
let droppingBot: ReturnType<typeof Bun.serve>;
let model: LLMock;
const runtimeTelemetry = process.env.COPILOTKIT_TELEMETRY_DISABLED;
const modelBase = process.env.OPENAI_BASE_URL;

const ACTOR = "colleague";
const KEY = "synthetic-privacy-key";

beforeAll(async () => {
  // The runtime's own telemetry goes nowhere from a test. OpenBot's is given its own env below.
  process.env.COPILOTKIT_TELEMETRY_DISABLED = "true";
  model = new LLMock();
  process.env.OPENAI_BASE_URL = `${await model.start()}/v1`;
  // Slow enough that a run is still answering when it is stopped.
  model.onMessage(
    /.*/,
    { content: "word ".repeat(200) },
    { latency: 50, chunkSize: 5 },
  );
  // A Bot whose stream ends partway, with no terminal event and nobody stopping it.
  droppingBot = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const input = (await request.json()) as RunAgentInput;
      const events = [
        { type: "RUN_STARTED", threadId: input.threadId, runId: input.runId },
        { type: "TEXT_MESSAGE_START", messageId: "reply", role: "assistant" },
        { type: "TEXT_MESSAGE_CONTENT", messageId: "reply", delta: "Half" },
      ];
      return new Response(
        events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  type Frame = [string | null, string | null, string, string, unknown];
  platform = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request, server) {
      const url = new URL(request.url);
      if (url.pathname === "/runner/websocket")
        return server.upgrade(request, {
          data: undefined,
          headers: { "Sec-WebSocket-Protocol": "phoenix" },
        })
          ? undefined
          : new Response("upgrade failed", { status: 400 });
      const text = await request.text();
      const body = (text ? JSON.parse(text) : {}) as Record<string, unknown>;
      const [, api, threads, threadId = "", rest] = url.pathname.split("/");
      if (api !== "api" || threads !== "threads")
        return Response.json({ error: "not found" }, { status: 404 });
      if (!rest && request.method === "POST")
        return Response.json({ thread: { id: body.threadId, name: "Named" } });
      if (rest === undefined && request.method === "GET")
        return Response.json({ thread: { id: threadId, name: "Named" } });
      if (rest === "messages") return Response.json({ messages: [] });
      if (rest === "lock" && request.method === "POST")
        return Response.json({
          threadId,
          runId: body.runId,
          joinToken: "join-token",
          ttlSeconds: 20,
        });
      // A thread named "taken" belongs to somebody else by the first renewal.
      if (rest === "lock" && request.method === "PATCH")
        return threadId.includes("taken")
          ? Response.json(
              { error: "THREAD_LOCK_RENEWAL_FAILED" },
              { status: 409 },
            )
          : Response.json({ ttlSeconds: 20 });
      if (rest === "lock" && request.method === "DELETE")
        return new Response(null, { status: 204 });
      return Response.json({ error: "not found" }, { status: 404 });
    },
    websocket: {
      message(socket, message) {
        const [joinRef, ref, topic, event, payload] = JSON.parse(
          String(message),
        ) as Frame;
        if (event === "phx_join") joined.set(topic, { socket, joinRef });
        if (event === "event")
          delivered.push(payload as (typeof delivered)[number]);
        if (event === "events")
          delivered.push(
            ...((payload as { events: typeof delivered }).events ?? []),
          );
        socket.send(
          JSON.stringify([
            joinRef,
            ref,
            topic,
            "phx_reply",
            { status: "ok", response: {} },
          ]),
        );
      },
    },
  });
});

afterAll(async () => {
  platform.stop(true);
  droppingBot.stop(true);
  await model.stop();
  if (runtimeTelemetry === undefined)
    delete process.env.COPILOTKIT_TELEMETRY_DISABLED;
  else process.env.COPILOTKIT_TELEMETRY_DISABLED = runtimeTelemetry;
  if (modelBase === undefined) delete process.env.OPENAI_BASE_URL;
  else process.env.OPENAI_BASE_URL = modelBase;
});

async function until(done: () => boolean, what: string) {
  const deadline = Date.now() + 10_000;
  while (!done()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await Bun.sleep(10);
  }
}

/** A person's Stop, relayed to the run's runner the way the gateway relays `stop_run`. */
function relayStop(runId: string) {
  const channel = joined.get(`ingestion:${runId}`);
  if (!channel) throw new Error(`no runner joined for ${runId}`);
  channel.socket.send(
    JSON.stringify([
      channel.joinRef,
      null,
      `ingestion:${runId}`,
      AG_UI_CHANNEL_EVENT,
      { type: EventType.CUSTOM, name: "stop" },
    ]),
  );
}

async function telemetry() {
  return createProductTelemetry({
    privacyKey: KEY,
    deploymentId: "dep_fixture_01",
    env: { OPENBOT_PRODUCT_TELEMETRY: "1", NODE_ENV: "test" },
    send: async (event) => {
      sent.push(event);
    },
  });
}
type Telemetry = Awaited<ReturnType<typeof telemetry>>;

/** How OpenBot's own product telemetry says a run ended. */
async function ending(product: Telemetry, runId: string) {
  await until(
    () =>
      sent.some(
        (event) =>
          event.event.endsWith("run_terminal") &&
          event.properties?.run_id === runId,
      ),
    `${runId}'s product terminal event`,
  );
  await product.flush();
  return sent
    .filter(
      (event) =>
        event.event.endsWith("run_terminal") &&
        event.properties?.run_id === runId,
    )
    .map((event) => ({
      outcome: event.properties?.outcome,
      failure: event.properties?.failure_category,
    }));
}

/* ------------------------------------------------------------------------------------------------
 * Browser runs, through the mounted runtime.
 * --------------------------------------------------------------------------------------------- */

function mount(product: Telemetry) {
  const builtIn = registeredAgentFromRow({
    id: "general-assistant",
    name: "General Assistant",
    type: "built_in",
    configuration: { systemPrompt: "Be helpful." },
    title: "Everyday Work",
    roleDescription: "Help with everyday work.",
  });
  const dropping = registeredAgentFromRow({
    id: "dropping",
    name: "Dropping",
    type: "remote_ag_ui",
    configuration: { endpoint: `http://127.0.0.1:${droppingBot.port}/ag-ui` },
    title: "Drops its stream",
    roleDescription: "Stop answering partway.",
  });
  if (!builtIn || !dropping) throw new Error("a Bot did not parse");
  return mountCopilotRuntime(
    loadConfig(
      testEnvironment({
        INTELLIGENCE_API_URL: `http://127.0.0.1:${platform.port}`,
        INTELLIGENCE_GATEWAY_WS_URL: `ws://127.0.0.1:${platform.port}`,
      }),
    ),
    createActorAgentResolver({
      productTelemetry: product,
      model: { provider: "openai", defaultModel: "gpt-test" },
      loadAgents: async () => [builtIn, dropping],
      resolveModelApiKey: async () => "model-key",
      agentFetch: createAgentFetch({ allowPrivateHosts: true }),
    }),
    async () => ({ id: ACTOR, name: "Colleague" }),
    async () => ({ id: ACTOR, role: "user" }),
    { productTelemetry: product },
  );
}

async function browserRun(
  runtime: ReturnType<typeof mount>,
  bot: string,
  runId: string,
) {
  const response = await runtime.handler.fetch(
    new Request(`http://127.0.0.1/api/copilotkit/agent/${bot}/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        threadId: `thread-${runId}`,
        runId,
        state: {},
        messages: [{ id: `ask-${runId}`, role: "user", content: "An essay." }],
        tools: [],
        context: [],
        forwardedProps: {},
      } satisfies RunAgentInput),
    }),
  );
  expect(response.status).toBe(200);
}

test("a person's Stop on a browser run reads cancelled", async () => {
  const product = await telemetry();
  await browserRun(mount(product), "general-assistant", "run-browser-stop");
  await until(
    () =>
      delivered.some(
        (e) =>
          e.runId === "run-browser-stop" && e.type === "TEXT_MESSAGE_CONTENT",
      ),
    "the Bot to be answering",
  );
  relayStop("run-browser-stop");
  expect(await ending(product, "run-browser-stop")).toEqual([
    { outcome: "cancelled", failure: "none" },
  ]);
});

test("a browser run whose stream ends with no terminal event and no stop still reads missing_terminal", async () => {
  const product = await telemetry();
  await browserRun(mount(product), "dropping", "run-dropped");
  expect(await ending(product, "run-dropped")).toEqual([
    { outcome: "unknown", failure: "missing_terminal" },
  ]);
});

/* ------------------------------------------------------------------------------------------------
 * Headless turns and hops, through the real Intelligence runner.
 * --------------------------------------------------------------------------------------------- */

/** A Bot that starts answering and works until it is stopped, ending its stream as it is aborted. */
class WorkingAgent extends AbstractAgent {
  static started: string[] = [];
  private working: Subscriber<BaseEvent> | undefined;
  run(input: RunAgentInput): Observable<BaseEvent> {
    return new Observable<BaseEvent>((subscriber) => {
      this.working = subscriber;
      WorkingAgent.started.push(input.runId);
      subscriber.next({
        type: EventType.RUN_STARTED,
        threadId: input.threadId,
        runId: input.runId,
      } as BaseEvent);
    });
  }
  override abortRun(): void {
    this.working?.complete();
    super.abortRun();
  }
}

function platformClient(): CopilotKitIntelligence {
  return createIntelligenceClient({
    apiUrl: `http://127.0.0.1:${platform.port}`,
    gatewayWsUrl: `ws://127.0.0.1:${platform.port}`,
    apiKey: "cpk-test-key",
  });
}

/** The headless turn every routine, task and subagent runs, wired as index.ts wires it. */
function turnOptions(
  product: Telemetry,
  admission?: () => Promise<AbortSignal>,
) {
  const client = platformClient();
  return {
    client,
    options: {
      prepareRunInput: productHeadlessBoundary(product),
      onKnownStop: product.stopKnown,
      // The turn's own signal, as the server's admission hands it back; a pause aborts a signal of its own.
      admission:
        admission ??
        (async ({ signal }: { signal?: AbortSignal }) =>
          signal ?? new AbortController().signal),
      intelligence: client,
      runner: new IntelligenceAgentRunner({
        url: client.ɵgetRunnerWsUrl(),
        authToken: client.ɵgetRunnerAuthToken(),
      }),
      heartbeatMs: 20,
    },
  };
}

/** The Bot, with OpenBot's product middleware on it as the resolver puts it on every Bot. */
function workingBot(product: Telemetry) {
  const agent = new WorkingAgent({ agentId: "bot_helper" });
  agent.use(product.middleware(ACTOR));
  return agent;
}

async function headlessTurn(
  product: Telemetry,
  runId: string,
  options: {
    signal?: AbortSignal;
    admission?: () => Promise<AbortSignal>;
    turnTimeoutMs?: number;
  } = {},
) {
  const { options: turn } = turnOptions(product, options.admission);
  return createTurnRunner({
    ...turn,
    buildAgentFor: async () => workingBot(product),
    ...(options.turnTimeoutMs ? { turnTimeoutMs: options.turnTimeoutMs } : {}),
  })({
    ownerUserId: ACTOR,
    routineId: "routine_standup",
    agentId: "bot_helper",
    threadId: `thread-${runId}`,
    runId,
    instruction: "Post the standup summary.",
    telemetry: { trigger: "routine", rootTaskId: `routine-run-${runId}` },
    ...(options.signal ? { signal: options.signal } : {}),
  }).then(
    () => "finished",
    () => "ended",
  );
}

const started = (runId: string) => () => WorkingAgent.started.includes(runId);

test("a headless turn its host cancels reads cancelled", async () => {
  const product = await telemetry();
  const cancel = new AbortController();
  const turn = headlessTurn(product, "run-cancel", { signal: cancel.signal });
  await until(started("run-cancel"), "the Bot to start");
  cancel.abort();
  await turn;
  expect(await ending(product, "run-cancel")).toEqual([
    { outcome: "cancelled", failure: "none" },
  ]);
});

test("a headless turn stopped by pausing its Bot reads cancelled", async () => {
  const product = await telemetry();
  const pause = new AbortController();
  const turn = headlessTurn(product, "run-pause", {
    admission: async () => pause.signal,
  });
  await until(started("run-pause"), "the Bot to start");
  pause.abort();
  await turn;
  expect(await ending(product, "run-pause")).toEqual([
    { outcome: "cancelled", failure: "none" },
  ]);
});

test("a headless turn stopped at its deadline reads the contract's timeout", async () => {
  const product = await telemetry();
  await headlessTurn(product, "run-deadline", { turnTimeoutMs: 200 });
  expect(await ending(product, "run-deadline")).toEqual([
    { outcome: "timeout", failure: "none" },
  ]);
});

test("a person's Stop on a headless turn's thread reads cancelled", async () => {
  const product = await telemetry();
  const turn = headlessTurn(product, "run-relayed");
  await until(started("run-relayed"), "the Bot to start");
  await until(
    () => joined.has("ingestion:run-relayed"),
    "the runner to join the run",
  );
  relayStop("run-relayed");
  await turn;
  expect(await ending(product, "run-relayed")).toEqual([
    { outcome: "cancelled", failure: "none" },
  ]);
});

test("a headless turn that loses its lock is not a cancellation", async () => {
  const product = await telemetry();
  expect(await headlessTurn(product, "run-taken")).toBe("ended");
  expect(await ending(product, "run-taken")).toEqual([
    { outcome: "unknown", failure: "missing_terminal" },
  ]);
});

test("a stop that cascades to a subagent reads cancelled for the subagent", async () => {
  const product = await telemetry();
  const { options: turn } = turnOptions(product);
  const subagents = createSubagents({
    turn,
    buildAgentFor: async () => workingBot(product),
    withdrawApprovals: async () => undefined,
  });
  const tool = subagents.toolForRun({
    actorId: ACTOR,
    botId: "bot_helper",
    threadId: "thread-parent",
    runId: "run-parent",
    initiator: PERSON_INITIATOR,
  });
  // The parent run's Stop reaches its tool call, and so the subagent it started, as its signal.
  const parentStop = new AbortController();
  const before = WorkingAgent.started.length;
  const call = Promise.resolve(
    tool.execute?.({ task: "Count the tickets.", answer: "A number." }, {
      toolCallId: "call-cascade",
      signal: parentStop.signal,
    } as never),
  ).then(
    () => "returned",
    () => "stopped",
  );
  await until(
    () => WorkingAgent.started.length > before,
    "the subagent to start",
  );
  const subagentRun = WorkingAgent.started.at(-1) ?? "";
  parentStop.abort();
  await call;
  expect(await ending(product, subagentRun)).toEqual([
    { outcome: "cancelled", failure: "none" },
  ]);
});

function hop(product: Telemetry, threadId: string, runId: string) {
  const client = platformClient();
  const pause = new AbortController();
  const delivery = createHandoffDelivery({
    admission: async () => pause.signal,
    prepareRunInput: (input, work) =>
      productHandoffInput(product, input, work.actorId, work.runId),
    onKnownStop: product.stopKnown,
    agentFor: async () => workingBot(product),
    history: async () => [],
    newRunId: () => runId,
    mintThreadId: () => threadId,
    lock: createIntelligenceThreadLock({ client }),
    runner: new IntelligenceAgentRunner({
      url: client.ɵgetRunnerWsUrl(),
      authToken: client.ɵgetRunnerAuthToken(),
    }) as never,
    renewEveryMs: 20,
  })
    .deliver({
      work: {
        fromBotId: "assistant",
        toBotId: "researcher",
        actorId: ACTOR,
        threadId: "thread-asking",
        runId: "run-asking",
        depth: 1,
        task: "find the outage window",
      },
      message: "m",
      shown: "s",
      assertion: "signed",
    })
    .then(
      () => "delivered",
      () => "ended",
    );
  return { delivery, pause };
}

test("a Bot-to-Bot hop stopped by a pause reads cancelled", async () => {
  const product = await telemetry();
  const { delivery, pause } = hop(product, "thread-hop-pause", "run-hop-pause");
  await until(started("run-hop-pause"), "the Bot to start");
  pause.abort(new Error("The Bot was paused."));
  expect(await delivery).toBe("ended");
  expect(await ending(product, "run-hop-pause")).toEqual([
    { outcome: "cancelled", failure: "none" },
  ]);
});

test("a Bot-to-Bot hop that loses its lock is not a cancellation", async () => {
  const product = await telemetry();
  const { delivery } = hop(product, "thread-hop-taken", "run-hop-taken");
  expect(await delivery).toBe("ended");
  expect(await ending(product, "run-hop-taken")).toEqual([
    { outcome: "unknown", failure: "missing_terminal" },
  ]);
});
