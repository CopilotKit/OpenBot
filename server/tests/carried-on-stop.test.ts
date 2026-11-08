import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  AbstractAgent,
  type BaseEvent,
  EventType,
  type RunAgentInput,
} from "@ag-ui/client";
import { IntelligenceAgentRunner } from "@copilotkit/runtime/v2";
import { createTurnRunner } from "@openbot/toolkit/run-turn";
import type { ServerWebSocket } from "bun";
import { Observable, type Subscriber } from "rxjs";
import { createActorAgentResolver } from "../src/agents/agent-resolver";
import { createCarriedOnTurns } from "../src/approvals/carried-on";
import { loadConfig } from "../src/config";
import { mountCopilotRuntime, registeredAgentFromRow } from "../src/copilot";
import { createIntelligenceClient } from "../src/intelligence-client";
import { testEnvironment } from "./support/environment";

/**
 * A person's Stop reaches the turn the server carries their conversation on in after an approval.
 *
 * Found on the Mac: after Allow once the conversation showed Stop, and pressing it did nothing. The
 * full answer arrived 9 to 13 seconds later. The browser has no run of its own there, so its Stop is
 * the thread's, on the runtime's stop route, and the runtime asks its own runner, which holds only
 * the runs it started. The carried-on turn runs on another runner (the one routines use), so the
 * route answered "no active run" and the turn went on.
 *
 * The real route: the handler `mountCopilotRuntime` returns, its real Intelligence runner, and the
 * carried-on turn through the real headless turn runner on a runner of its own, as index.ts wires
 * it. The Intelligence platform is the fake, REST and the runners' Phoenix channel on 127.0.0.1. The
 * Bot works until it is stopped.
 */

const ACTOR = "colleague";
let platform: ReturnType<typeof Bun.serve>;
const joined = new Map<string, ServerWebSocket<unknown>>();

beforeAll(() => {
  process.env.COPILOTKIT_TELEMETRY_DISABLED = "true";
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
      if (rest === "lock" && request.method === "PATCH")
        return Response.json({ ttlSeconds: 20 });
      if (rest === "lock" && request.method === "DELETE")
        return new Response(null, { status: 204 });
      return Response.json({ error: "not found" }, { status: 404 });
    },
    websocket: {
      message(socket, message) {
        const [joinRef, ref, topic, event] = JSON.parse(
          String(message),
        ) as Frame;
        if (event === "phx_join") joined.set(topic, socket);
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

async function until(done: () => boolean, what: string) {
  const deadline = Date.now() + 10_000;
  while (!done()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await Bun.sleep(10);
  }
}

/** A Bot that starts answering and works until it is stopped, ending its stream as it is aborted. */
class WorkingAgent extends AbstractAgent {
  static started: string[] = [];
  private working: Subscriber<BaseEvent> | undefined;
  run(input: RunAgentInput): Observable<BaseEvent> {
    return new Observable<BaseEvent>((subscriber) => {
      this.working = subscriber;
      WorkingAgent.started.push(input.threadId);
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

function platformClient() {
  return createIntelligenceClient({
    apiUrl: `http://127.0.0.1:${platform.port}`,
    gatewayWsUrl: `ws://127.0.0.1:${platform.port}`,
    apiKey: "cpk-test-key",
  });
}

/** The runtime a person's browser talks to, with the carried-on turns wired in as index.ts does. */
function mount(stopCarriedOn: (threadId: string) => Promise<boolean>) {
  const builtIn = registeredAgentFromRow({
    id: "general-assistant",
    name: "General Assistant",
    type: "built_in",
    configuration: { systemPrompt: "Be helpful." },
    title: "Everyday Work",
    roleDescription: "Help with everyday work.",
  });
  if (!builtIn) throw new Error("the Bot did not parse");
  return mountCopilotRuntime(
    loadConfig(
      testEnvironment({
        INTELLIGENCE_API_URL: `http://127.0.0.1:${platform.port}`,
        INTELLIGENCE_GATEWAY_WS_URL: `ws://127.0.0.1:${platform.port}`,
      }),
    ),
    createActorAgentResolver({
      model: { provider: "openai", defaultModel: "gpt-test" },
      loadAgents: async () => [builtIn],
      resolveModelApiKey: async () => "model-key",
    }),
    async () => ({ id: ACTOR, name: "Colleague" }),
    async () => ({ id: ACTOR, role: "user" }),
    { stopCarriedOn },
  );
}

/** The approval continuation runner, as index.ts builds it: a headless turn on a runner of its own. */
function carriedOnRunner() {
  const client = platformClient();
  return createTurnRunner({
    admission: async ({ signal }) => signal ?? new AbortController().signal,
    intelligence: client,
    runner: new IntelligenceAgentRunner({
      url: client.ɵgetRunnerWsUrl(),
      authToken: client.ɵgetRunnerAuthToken(),
    }),
    heartbeatMs: 20,
    buildAgentFor: async () => new WorkingAgent({ agentId: "maps-bot" }),
  });
}

/** The browser's Stop with no run of its own to name: the thread's, on the runtime's route. */
async function pressStop(runtime: ReturnType<typeof mount>, threadId: string) {
  const response = await runtime.handler.fetch(
    new Request(
      `http://127.0.0.1/api/copilotkit/agent/general-assistant/stop/${threadId}`,
      { method: "POST" },
    ),
  );
  expect(response.status).toBe(200);
  return (await response.json()) as { stopped: boolean };
}

test("Stop on a conversation the server carries on after an approval stops the turn", async () => {
  const carried = createCarriedOnTurns();
  const runtime = mount((threadId) => carried.stop(threadId));
  const runTurn = carriedOnRunner();
  const threadId = "thread-maps-carried-on";

  const turn = carried.run(
    threadId,
    (signal) =>
      runTurn({
        ownerUserId: ACTOR,
        routineId: "approval",
        agentId: "maps-bot",
        threadId,
        instruction: "",
        signal,
      }).then(() => "answered"),
    () => "stopped",
  );
  await until(
    () => WorkingAgent.started.includes(threadId),
    "the carried-on turn to start",
  );

  expect(await pressStop(runtime, threadId)).toMatchObject({ stopped: true });
  // Stopped, not answered: the Bot never gets to the end of its answer.
  expect(await turn).toBe("stopped");
});

test("Stop on a thread with no run anywhere still answers that nothing was stopped", async () => {
  const carried = createCarriedOnTurns();
  const runtime = mount((threadId) => carried.stop(threadId));
  expect(await pressStop(runtime, "thread-idle")).toMatchObject({
    stopped: false,
  });
});
