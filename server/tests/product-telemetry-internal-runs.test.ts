import { afterAll, beforeAll, expect, test } from "bun:test";
import type { RunAgentInput } from "@ag-ui/client";
import type { LambdaSendOptions } from "@copilotkit/shared";
import { createActorAgentResolver } from "../src/agents/agent-resolver";
import { createAgentFetch } from "../src/agents/endpoint";
import { loadConfig } from "../src/config";
import { mountCopilotRuntime, registeredAgentFromRow } from "../src/copilot";
import { createProductTelemetry } from "../src/telemetry/product";
import { testEnvironment } from "./support/environment";

/**
 * Only work somebody asked for is counted as an OpenBot run.
 *
 * The CopilotKit runtime names a new conversation itself: it builds the conversation's Bot again and
 * runs it in-process on a title prompt. That run goes through the same agent, so the product
 * middleware sees it, and it carries no context of OpenBot's because nobody asked for it. It used to
 * be counted as a run with an unknown trigger and no root task, once per new conversation.
 *
 * Driven through the real path: the handler `mountCopilotRuntime` returns, a Bot built from a stored
 * row, and the runtime's own thread naming. The Intelligence platform underneath is the fake, REST
 * and the runner's Phoenix channel, on 127.0.0.1; the Bot's endpoint stands in for its model.
 */

const sent: LambdaSendOptions[] = [];
const seen: { forwardedProps: unknown }[] = [];
const delivered: { runId?: string; type?: string }[] = [];
const named: string[] = [];
const created = new Set<string>();

let endpoint: ReturnType<typeof Bun.serve>;
let platform: ReturnType<typeof Bun.serve>;

// The runtime's own telemetry goes nowhere from a test. OpenBot's is given its own env below.
const runtimeTelemetry = process.env.COPILOTKIT_TELEMETRY_DISABLED;

beforeAll(() => {
  process.env.COPILOTKIT_TELEMETRY_DISABLED = "true";
  endpoint = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const input = (await request.json()) as RunAgentInput;
      seen.push({ forwardedProps: input.forwardedProps });
      const reply = '{"title":"Standup notes"}';
      const events = [
        { type: "RUN_STARTED", threadId: input.threadId, runId: input.runId },
        { type: "TEXT_MESSAGE_START", messageId: "reply", role: "assistant" },
        { type: "TEXT_MESSAGE_CONTENT", messageId: "reply", delta: reply },
        { type: "TEXT_MESSAGE_END", messageId: "reply" },
        { type: "RUN_FINISHED", threadId: input.threadId, runId: input.runId },
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
      const [, api, threads, threadId, rest] = url.pathname.split("/");
      if (api !== "api" || threads !== "threads")
        return Response.json({ error: "not found" }, { status: 404 });
      // A thread nobody has run yet does not exist, so the runtime creates it and names it.
      if (!threadId && request.method === "POST") {
        created.add(String(body.threadId));
        return Response.json({ thread: { id: body.threadId, name: null } });
      }
      if (threadId && rest === undefined && request.method === "GET")
        return created.has(threadId)
          ? Response.json({ thread: { id: threadId, name: null } })
          : Response.json({ error: "THREAD_NOT_FOUND" }, { status: 404 });
      if (threadId && rest === undefined && request.method === "PATCH") {
        named.push(String(body.name));
        return Response.json({ thread: { id: threadId, name: body.name } });
      }
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
        const [joinRef, ref, topic, event, payload] = JSON.parse(
          String(message),
        ) as Frame;
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

afterAll(() => {
  endpoint.stop(true);
  platform.stop(true);
  if (runtimeTelemetry === undefined)
    delete process.env.COPILOTKIT_TELEMETRY_DISABLED;
  else process.env.COPILOTKIT_TELEMETRY_DISABLED = runtimeTelemetry;
});

async function until(done: () => boolean, what: string) {
  const deadline = Date.now() + 10_000;
  while (!done()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await Bun.sleep(10);
  }
}

test("naming a new conversation is not counted as an OpenBot run", async () => {
  const productTelemetry = await createProductTelemetry({
    privacyKey: "synthetic-privacy-key",
    deploymentId: "dep_fixture_01",
    env: { OPENBOT_PRODUCT_TELEMETRY: "1", NODE_ENV: "test" },
    send: async (event) => {
      sent.push(event);
    },
  });
  const bot = registeredAgentFromRow({
    id: "standup",
    name: "Standup",
    type: "remote_ag_ui",
    configuration: { endpoint: `http://127.0.0.1:${endpoint.port}/ag-ui` },
    title: "Standup Bot",
    roleDescription: "Write the standup.",
  });
  if (!bot) throw new Error("the Bot did not parse");
  const person = { id: "colleague", name: "Colleague" };
  const runtime = mountCopilotRuntime(
    loadConfig(
      testEnvironment({
        INTELLIGENCE_API_URL: `http://127.0.0.1:${platform.port}`,
        INTELLIGENCE_GATEWAY_WS_URL: `ws://127.0.0.1:${platform.port}`,
      }),
    ),
    createActorAgentResolver({
      productTelemetry,
      model: { provider: "openai", defaultModel: "unused" },
      loadAgents: async () => [bot],
      resolveModelApiKey: async () => null,
      agentFetch: createAgentFetch({ allowPrivateHosts: true }),
    }),
    async () => person,
    async () => ({ id: person.id, role: "user" }),
    { productTelemetry },
  );

  const response = await runtime.handler.fetch(
    new Request("http://127.0.0.1/api/copilotkit/agent/standup/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        threadId: "thread-new",
        runId: "run-person",
        state: {},
        messages: [
          { id: "ask-1", role: "user", content: "Write the standup." },
        ],
        tools: [],
        context: [],
        forwardedProps: {},
      } satisfies RunAgentInput),
    }),
  );
  expect(response.status).toBe(200);
  await until(
    () =>
      delivered.some(
        (event) =>
          event.runId === "run-person" && event.type === "RUN_FINISHED",
      ),
    "the person's run to finish",
  );
  await until(() => named.length > 0, "the conversation to be named");
  await productTelemetry.flush();

  // Both ran on the Bot: the person's run, and the runtime's own run that named the conversation.
  expect(seen).toHaveLength(2);
  expect(named).toEqual(["Standup notes"]);
  // Only the person's run is an OpenBot run.
  const runs = sent
    .filter((event) => /run_(accepted|terminal)$/.test(event.event))
    .map((event) => ({
      event: event.event.replace("oss.runtime.openbot.", ""),
      trigger: event.properties?.trigger,
      run: event.properties?.run_id,
    }));
  expect(runs).toEqual([
    { event: "run_accepted", trigger: "human", run: "run-person" },
    { event: "run_terminal", trigger: "human", run: "run-person" },
  ]);
});
