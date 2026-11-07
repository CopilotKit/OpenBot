import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  AbstractAgent,
  type BaseEvent,
  EventType,
  type RunAgentInput,
} from "@ag-ui/client";
import {
  CopilotKitIntelligence,
  IntelligenceAgentRunner,
} from "@copilotkit/runtime/v2";
import { createIntelligenceThreadLock } from "@openbot/toolkit/copilotkit/thread-lock";
import { stopRecorder } from "@openbot/toolkit/run-stop";
import { createTurnRunner } from "@openbot/toolkit/run-turn";
import { Observable, type Subscriber } from "rxjs";
import { createHandoffDelivery } from "../src/agents/handoff-delivery";
import { createIntelligenceClient } from "../src/intelligence-client";

/**
 * A stop OpenBot makes in a headless turn is recorded with Intelligence before the run's terminal
 * event, so the run's summary reads `cancelled` rather than `success`.
 *
 * The Intelligence platform is the fake here, on 127.0.0.1: REST and the runner's Phoenix channel,
 * writing down when a stop is recorded (`POST /api/threads/:id/connect`, the first step of
 * recording one) and when a run's terminal event arrives.
 *
 * CopilotKit records stops from 1.85.0 (`ɵrecordRunStop` on the client, `recordStop` on the
 * Intelligence runner), and that is what CI installs; `@copilotkit/runtime` 1.83.0 had neither. So
 * where an installed runtime lacks it, two stand-ins carry that release's behaviour on top of the
 * real client and runner: `recordingStops` gives the client the method, and
 * `StopRecordingRunner` calls a run's `recordStop` when it is asked to stop the run, within two
 * seconds, before the terminal event, and stops the run whatever the record did. Where the installed
 * runtime records stops itself, its runner does that and the stand-in does nothing, so a stop is
 * recorded once, as it is in production. The last test is the runtime exactly as installed.
 */

/** Whether the installed runtime records the stops its runner makes (1.85.0 and later). */
const runtimeRecordsStops =
  typeof (CopilotKitIntelligence.prototype as { ɵrecordRunStop?: unknown })
    .ɵrecordRunStop === "function";

const OWNER = "user_owner";
const AGENT = "bot_helper";

type Moment = { at: "connect" | "stop_run" | "terminal"; threadId: string };
const timeline: Moment[] = [];
const requests: { method: string; path: string }[] = [];
let platform: ReturnType<typeof Bun.serve>;

beforeAll(() => {
  type Frame = [string | null, string | null, string, string, unknown];
  platform = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request, server) {
      const url = new URL(request.url);
      // The runner's socket, and the client socket a recorded stop is sent on.
      if (
        url.pathname === "/runner/websocket" ||
        url.pathname === "/client/websocket"
      )
        // The subprotocol the client asked for, if any: the runner asks for `phoenix`, a client does not.
        return server.upgrade(
          request,
          request.headers.get("sec-websocket-protocol")
            ? {
                data: undefined,
                headers: { "Sec-WebSocket-Protocol": "phoenix" },
              }
            : { data: undefined },
        )
          ? undefined
          : new Response("upgrade failed", { status: 400 });
      const text = await request.text();
      const body = (text ? JSON.parse(text) : {}) as Record<string, unknown>;
      requests.push({ method: request.method, path: url.pathname });
      const [, api, threads, threadId = "", rest] = url.pathname.split("/");
      if (api !== "api" || threads !== "threads")
        return Response.json({ error: "not found" }, { status: 404 });
      if (!rest && request.method === "POST")
        return Response.json({ thread: { id: body.threadId } });
      if (rest === undefined && request.method === "GET")
        return Response.json({ thread: { id: threadId } });
      if (rest === "messages") return Response.json({ messages: [] });
      if (rest === "connect") {
        timeline.push({ at: "connect", threadId });
        return threadId.includes("unrecordable")
          ? Response.json({ error: "unavailable" }, { status: 503 })
          : Response.json({ joinToken: "stop-join-token" });
      }
      if (rest === "lock" && request.method === "POST")
        return Response.json({
          threadId,
          runId: body.runId,
          joinToken: "join-token",
          ttlSeconds: 120,
        });
      if (rest === "lock" && request.method === "PATCH")
        return threadId.includes("taken")
          ? Response.json(
              { error: "THREAD_LOCK_RENEWAL_FAILED" },
              { status: 409 },
            )
          : Response.json({ ttlSeconds: 120 });
      if (rest === "lock" && request.method === "DELETE")
        return new Response(null, { status: 204 });
      return Response.json({ error: "not found" }, { status: 404 });
    },
    websocket: {
      message(socket, message) {
        const [joinRef, ref, topic, event, payload] = JSON.parse(
          String(message),
        ) as Frame;
        const pushed =
          event === "event"
            ? [payload]
            : event === "events"
              ? ((payload as { events: unknown[] }).events ?? [])
              : [];
        for (const item of pushed as { type?: string; threadId?: string }[])
          if (item.type === "RUN_FINISHED" || item.type === "RUN_ERROR")
            timeline.push({ at: "terminal", threadId: item.threadId ?? "" });
        // A browser's Stop, and a stop the runtime records, as the gateway receives it.
        if (event === "stop_run" && topic.startsWith("thread:"))
          timeline.push({ at: "stop_run", threadId: topic.slice(7) });
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

afterAll(() => {
  platform.stop(true);
});

function installedClient(): CopilotKitIntelligence {
  return createIntelligenceClient({
    apiUrl: `http://127.0.0.1:${platform.port}`,
    gatewayWsUrl: `ws://127.0.0.1:${platform.port}`,
    apiKey: "cpk-test-key",
  });
}

/**
 * How long a stop's record takes before it reaches Intelligence. Long enough that a terminal event
 * the runner did not hold behind the record would arrive first, every time rather than by chance.
 */
const RECORD_ROUND_TRIP_MS = 25;

/** The client as the release that records stops has it: `ɵrecordRunStop` asks for a join token first. */
function recordingStops(client: CopilotKitIntelligence) {
  const recorded: Record<string, unknown>[] = [];
  const withMethod = new Proxy(client, {
    get(target, property) {
      if (property !== "ɵrecordRunStop")
        return Reflect.get(target, property, target);
      return async (params: {
        threadId: string;
        runId: string;
        userId: string;
        agentId: string;
        signal?: AbortSignal;
      }) => {
        const { signal, ...run } = params;
        // A real record is a request and a socket join; it is never instant, so it takes this long.
        await Bun.sleep(RECORD_ROUND_TRIP_MS);
        recorded.push({ ...run, signalled: signal instanceof AbortSignal });
        const response = await fetch(
          `http://127.0.0.1:${platform.port}/api/threads/${encodeURIComponent(params.threadId)}/connect`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              userId: params.userId,
              agentId: params.agentId,
            }),
            ...(signal ? { signal } : {}),
          },
        );
        if (!response.ok)
          throw new Error(`Intelligence refused the stop: ${response.status}`);
      };
    },
  });
  return { client: withMethod, recorded };
}

/**
 * The Intelligence runner as the release that records stops has it (1.85.0, `runner/intelligence.ts`),
 * on top of the installed one where that does not record stops itself. Asked to stop a run, it starts
 * the record and aborts the run's agent at once, and holds only the run's end, which is what its
 * terminal event follows, until the record settles or two seconds pass. A record that fails never
 * keeps the run going. Something else aborting the agent first, as a turn's own stop does, cannot
 * get the terminal event out ahead of the record, because the end it waits on is held.
 */
class StopRecordingRunner extends IntelligenceAgentRunner {
  readonly armed: boolean[] = [];
  private readonly records = new Map<
    string,
    { record: (signal: AbortSignal) => Promise<void>; agent: AbstractAgent }
  >();
  private readonly recording = new Map<string, Promise<void>>();

  override run(request: Parameters<IntelligenceAgentRunner["run"]>[0]) {
    const recordStop = (
      request as { recordStop?: (signal: AbortSignal) => Promise<void> }
    ).recordStop;
    this.armed.push(recordStop !== undefined);
    if (recordStop && !runtimeRecordsStops) {
      const { threadId, agent } = request;
      this.records.set(threadId, { record: recordStop, agent });
      const runAgent = agent.runAgent.bind(agent);
      agent.runAgent = (async (...args: Parameters<typeof runAgent>) => {
        try {
          return await runAgent(...args);
        } finally {
          await this.recording.get(threadId);
        }
      }) as typeof agent.runAgent;
    }
    return super.run(request);
  }

  override async stop(request: Parameters<IntelligenceAgentRunner["stop"]>[0]) {
    const run = this.records.get(request.threadId);
    if (!run || this.recording.has(request.threadId))
      return super.stop(request);
    const recorded = recordWithin(run.record, 2_000);
    this.recording.set(request.threadId, recorded);
    try {
      run.agent.abortRun();
    } catch {}
    await recorded;
    return super.stop(request);
  }
}

/** A stop's record, bounded by the runner's deadline. Never rejects: an unrecorded stop still stops. */
function recordWithin(
  record: (signal: AbortSignal) => Promise<void>,
  deadlineMs: number,
): Promise<void> {
  return new Promise<void>((resolve) => {
    const deadline = new AbortController();
    const timer = setTimeout(() => {
      deadline.abort();
      resolve();
    }, deadlineMs);
    Promise.resolve()
      .then(() => record(deadline.signal))
      .then(
        () => {
          clearTimeout(timer);
          resolve();
        },
        () => {
          clearTimeout(timer);
          resolve();
        },
      );
  });
}

function runnerFor(client: CopilotKitIntelligence) {
  return new StopRecordingRunner({
    url: client.ɵgetRunnerWsUrl(),
    authToken: client.ɵgetRunnerAuthToken(),
  });
}

/** A Bot that starts and then works until it is stopped. */
class WorkingAgent extends AbstractAgent {
  static started = 0;
  private working: Subscriber<BaseEvent> | undefined;
  run(input: RunAgentInput): Observable<BaseEvent> {
    return new Observable<BaseEvent>((subscriber) => {
      this.working = subscriber;
      WorkingAgent.started += 1;
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

/** A Bot that answers and finishes. */
class AnsweringAgent extends AbstractAgent {
  run(input: RunAgentInput): Observable<BaseEvent> {
    return new Observable<BaseEvent>((subscriber) => {
      const ids = { threadId: input.threadId, runId: input.runId };
      for (const event of [
        { type: EventType.RUN_STARTED, ...ids },
        {
          type: EventType.TEXT_MESSAGE_START,
          messageId: "reply",
          role: "assistant",
        },
        {
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId: "reply",
          delta: "Done.",
        },
        { type: EventType.TEXT_MESSAGE_END, messageId: "reply" },
        { type: EventType.RUN_FINISHED, ...ids },
      ])
        subscriber.next(event as BaseEvent);
      subscriber.complete();
    });
  }
}

function headlessTurn(
  client: CopilotKitIntelligence,
  runner: StopRecordingRunner,
  agent: () => AbstractAgent,
  options: { heartbeatMs?: number; turnTimeoutMs?: number } = {},
) {
  return createTurnRunner({
    admission: async ({ signal }) => signal ?? new AbortController().signal,
    intelligence: client,
    runner,
    buildAgentFor: async () => agent(),
    heartbeatMs: options.heartbeatMs ?? 60_000,
    ...(options.turnTimeoutMs ? { turnTimeoutMs: options.turnTimeoutMs } : {}),
  });
}

async function until(done: () => boolean, what: string) {
  const deadline = Date.now() + 10_000;
  while (!done()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await Bun.sleep(5);
  }
}

/** Run a turn that works until its host cancels it, and cancel it once it has started. */
async function cancelledTurn(
  client: CopilotKitIntelligence,
  runner: StopRecordingRunner,
  threadId: string,
) {
  const controller = new AbortController();
  const started = WorkingAgent.started;
  const turn = headlessTurn(
    client,
    runner,
    () => new WorkingAgent(),
  )({
    ownerUserId: OWNER,
    routineId: "routine_standup",
    agentId: AGENT,
    threadId,
    runId: `run-${threadId}`,
    instruction: "Post the standup summary.",
    signal: controller.signal,
  });
  await until(() => WorkingAgent.started > started, "the Bot to start");
  controller.abort();
  return turn.then(
    () => "finished",
    (error: unknown) => (error instanceof Error ? error.message : "failed"),
  );
}

const moments = (threadId: string) =>
  timeline.filter((moment) => moment.threadId === threadId).map((m) => m.at);

test("a headless turn its host stops records the stop before the run's terminal event", async () => {
  const { client, recorded } = recordingStops(installedClient());
  const runner = runnerFor(client);
  expect(await cancelledTurn(client, runner, "thread-cancelled")).toBe(
    "The headless turn was cancelled.",
  );
  expect(runner.armed).toEqual([true]);
  expect(recorded).toEqual([
    {
      threadId: "thread-cancelled",
      runId: "run-thread-cancelled",
      userId: OWNER,
      agentId: AGENT,
      signalled: true,
    },
  ]);
  expect(moments("thread-cancelled")).toEqual(["connect", "terminal"]);
});

test("a turn that finishes records no stop", async () => {
  const { client, recorded } = recordingStops(installedClient());
  const runner = runnerFor(client);
  const { replyText } = await headlessTurn(
    client,
    runner,
    () => new AnsweringAgent(),
  )({
    ownerUserId: OWNER,
    routineId: "routine_standup",
    agentId: AGENT,
    threadId: "thread-finished",
    instruction: "Post the standup summary.",
  });
  expect(replyText).toBe("Done.");
  // Armed, and never called: only a stop records anything.
  expect(runner.armed).toEqual([true]);
  expect(recorded).toEqual([]);
  expect(moments("thread-finished")).toEqual(["terminal"]);
});

test("a stop Intelligence cannot record still stops the run and gives the thread back", async () => {
  const { client, recorded } = recordingStops(installedClient());
  const runner = runnerFor(client);
  expect(await cancelledTurn(client, runner, "thread-unrecordable")).toBe(
    "The headless turn was cancelled.",
  );
  expect(recorded).toHaveLength(1);
  expect(moments("thread-unrecordable")).toEqual(["connect", "terminal"]);
  expect(
    requests.filter(
      (r) =>
        r.method === "DELETE" &&
        r.path === "/api/threads/thread-unrecordable/lock",
    ),
  ).toHaveLength(1);
});

test("a turn that lost its thread's lock records no stop for it", async () => {
  const { client, recorded } = recordingStops(installedClient());
  const runner = runnerFor(client);
  const outcome = await headlessTurn(client, runner, () => new WorkingAgent(), {
    heartbeatMs: 20,
  })({
    ownerUserId: OWNER,
    routineId: "routine_standup",
    agentId: AGENT,
    threadId: "thread-taken",
    instruction: "Post the standup summary.",
  }).then(
    () => "finished",
    () => "failed",
  );
  expect(outcome).toBe("failed");
  expect(runner.armed).toEqual([true]);
  expect(recorded).toEqual([]);
  expect(moments("thread-taken")).toEqual(["terminal"]);
});

test("a Bot-to-Bot hop stopped by a pause records the stop before its terminal event", async () => {
  const { client, recorded } = recordingStops(installedClient());
  const runner = runnerFor(client);
  const agent = new WorkingAgent();
  const pause = new AbortController();
  const started = WorkingAgent.started;
  const hop = createHandoffDelivery({
    admission: async () => pause.signal,
    agentFor: async () => agent,
    history: async () => [],
    newRunId: () => "run-hop",
    mintThreadId: () => "thread-hop",
    lock: createIntelligenceThreadLock({ client }),
    recordStopFor: (run, holdsLock) => stopRecorder(client, run, holdsLock),
    runner: runner as never,
  })
    .deliver({
      work: {
        fromBotId: "assistant",
        toBotId: "researcher",
        actorId: OWNER,
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
      () => "stopped",
    );
  await until(() => WorkingAgent.started > started, "the Bot to start");
  pause.abort(new Error("The Bot was paused."));
  expect(await hop).toBe("stopped");
  expect(recorded).toEqual([
    {
      threadId: "thread-hop",
      runId: "run-hop",
      userId: OWNER,
      agentId: "researcher",
      signalled: true,
    },
  ]);
  // A paused hop does not wait for its stop to finish, so the terminal event can land after it fails.
  await until(
    () => moments("thread-hop").includes("terminal"),
    "the hop's terminal event",
  );
  expect(moments("thread-hop")).toEqual(["connect", "terminal"]);
});

test("on the installed runtime, a client without the method is handed nothing and the stop still works", async () => {
  const client = installedClient();
  const runner = runnerFor(client);
  expect(await cancelledTurn(client, runner, "thread-installed")).toBe(
    "The headless turn was cancelled.",
  );
  // `@copilotkit/runtime` 1.83.0 has no `ɵrecordRunStop`; a release that has it is handed one.
  expect(runner.armed).toEqual([
    typeof (client as { ɵrecordRunStop?: unknown }).ɵrecordRunStop ===
      "function",
  ]);
  // Where it has the method, the installed client records the stop the gateway's way, once.
  expect(moments("thread-installed")).toEqual(
    runner.armed[0] ? ["connect", "stop_run", "terminal"] : ["terminal"],
  );
  expect(
    requests.filter(
      (r) =>
        r.method === "DELETE" &&
        r.path === "/api/threads/thread-installed/lock",
    ),
  ).toHaveLength(1);
});

test("a paused hop's run is closed on the platform before the hop lets go of it", async () => {
  const client = installedClient();
  // The installed runner, unchanged: this holds on 1.83.0 as it stood, and on the runtime now.
  const runner = new IntelligenceAgentRunner({
    url: client.ɵgetRunnerWsUrl(),
    authToken: client.ɵgetRunnerAuthToken(),
  });
  const pause = new AbortController();
  const started = WorkingAgent.started;
  const hop = createHandoffDelivery({
    admission: async () => pause.signal,
    agentFor: async () => new WorkingAgent(),
    history: async () => [],
    newRunId: () => "run-paused-hop",
    mintThreadId: () => "thread-paused-hop",
    lock: createIntelligenceThreadLock({ client }),
    runner: runner as never,
  })
    .deliver({
      work: {
        fromBotId: "assistant",
        toBotId: "researcher",
        actorId: OWNER,
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
      (error: unknown) => (error instanceof Error ? error.message : "failed"),
    );
  await until(() => WorkingAgent.started > started, "the Bot to start");
  pause.abort(new Error("The Bot was paused."));
  expect(await hop).toBe("The Bot was paused.");
  // By the time the hop gives up, the stopped run's terminal event is on the platform.
  expect(moments("thread-paused-hop")).toEqual(["terminal"]);
  expect(
    requests.filter(
      (r) =>
        r.method === "DELETE" &&
        r.path === "/api/threads/thread-paused-hop/lock",
    ),
  ).toHaveLength(1);
});
