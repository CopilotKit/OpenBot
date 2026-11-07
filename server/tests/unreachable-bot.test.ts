import { afterAll, beforeAll, expect, test } from "bun:test";
import type { RunAgentInput } from "@ag-ui/client";
import { createActorAgentResolver } from "../src/agents/agent-resolver";
import { createAgentFetch } from "../src/agents/endpoint";
import { isUnreachable } from "../src/agents/unreachable";
import { loadConfig } from "../src/config";
import { mountCopilotRuntime, registeredAgentFromRow } from "../src/copilot";
import { testEnvironment } from "./support/environment";

/**
 * A Bot whose address answers nothing, as the person reading the conversation is told.
 *
 * Seen on OpenBot Desktop: the personal starter was left pointing at a harness that had stopped, and
 * every message ended in red with "ECONNREFUSED: Unable to connect. Is the computer able to access
 * the url?". The run here goes through the real runtime and the fetch index.ts builds, to an address
 * where nothing listens, and the RUN_ERROR that reaches the platform is what both surfaces draw.
 */

/** AG-UI events the runner delivered to the platform. */
const delivered: { runId?: string; type?: string; message?: string }[] = [];

let platform: ReturnType<typeof Bun.serve>;
/** A loopback port nothing listens on: bound, read and released. */
let closedPort: number;

beforeAll(() => {
  const released = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(),
  });
  closedPort = released.port as number;
  released.stop(true);

  // Intelligence, as small as a run needs: the thread, its lock, and the runner's channel, every
  // push acknowledged. The same fake copilot-forwarded-headers.test.ts drives a remote run with.
  type Frame = [
    string | null,
    string | null,
    string,
    string,
    Record<string, unknown>,
  ];
  platform = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request, server) {
      const url = new URL(request.url);
      if (url.pathname === "/runner/websocket") {
        return server.upgrade(request, {
          data: undefined,
          headers: { "Sec-WebSocket-Protocol": "phoenix" },
        })
          ? undefined
          : new Response("upgrade failed", { status: 400 });
      }
      const [, api, threads, threadId, rest] = url.pathname.split("/");
      if (api === "api" && threads === "threads" && threadId) {
        if (rest === undefined && request.method === "GET")
          return Response.json({ thread: { id: threadId, name: "Mine" } });
        if (rest === "messages" && request.method === "GET")
          return Response.json({ messages: [] });
        if (rest === "lock" && request.method === "POST") {
          const body = (await request.json()) as { runId: string };
          return Response.json({
            threadId,
            runId: body.runId,
            joinToken: "join-token",
            ttlSeconds: 20,
          });
        }
        if (rest === "lock" && request.method === "PATCH")
          return Response.json({ ttlSeconds: 20 });
        if (rest === "lock" && request.method === "DELETE")
          return new Response(null, { status: 204 });
      }
      return Response.json({ error: "not found" }, { status: 404 });
    },
    websocket: {
      message(socket, message) {
        const [joinRef, ref, topic, event, payload] = JSON.parse(
          String(message),
        ) as Frame;
        if (event === "event") delivered.push(payload);
        if (event === "events")
          delivered.push(...(payload.events as typeof delivered));
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

test("a Bot that can't be reached is named in words, without the socket error", async () => {
  const config = loadConfig(
    testEnvironment({
      INTELLIGENCE_API_URL: `http://127.0.0.1:${platform.port}`,
      INTELLIGENCE_GATEWAY_WS_URL: `ws://127.0.0.1:${platform.port}`,
    }),
  );
  const bot = registeredAgentFromRow({
    id: "picked-harness",
    name: "Personal Assistant F5",
    type: "remote_ag_ui",
    configuration: { endpoint: `http://127.0.0.1:${closedPort}/` },
    title: "Everyday life.",
    roleDescription: "Answer.",
  });
  if (!bot) throw new Error("the Bot did not parse");
  const person = { id: "person", name: "Person" };
  const runtime = mountCopilotRuntime(
    config,
    createActorAgentResolver({
      model: { provider: "openai", defaultModel: "unused" },
      loadAgents: async () => [bot],
      resolveModelApiKey: async () => null,
      agentFetch: createAgentFetch({ allowPrivateHosts: true }),
    }),
    async () => person,
    async () => ({ id: person.id, role: "user" }),
  );
  const runId = `run-${crypto.randomUUID()}`;
  const response = await runtime.handler.fetch(
    new Request("http://127.0.0.1/api/copilotkit/agent/picked-harness/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        threadId: `thread-${runId}`,
        runId,
        state: {},
        messages: [{ id: `ask-${runId}`, role: "user", content: "Hello?" }],
        tools: [],
        context: [],
        forwardedProps: {},
      } satisfies RunAgentInput),
    }),
  );
  expect(response.status).toBe(200);
  const deadline = Date.now() + 8_000;
  const failure = () =>
    delivered.find(
      (event) => event.runId === runId && event.type === "RUN_ERROR",
    );
  while (!failure()) {
    if (Date.now() > deadline) {
      throw new Error(
        `the run never failed: ${JSON.stringify(delivered.map(({ type, message }) => ({ type, message })))}`,
      );
    }
    await Bun.sleep(10);
  }
  expect(failure()?.message).toBe(
    "Couldn't reach Personal Assistant F5. Check that it's running and that its address on its Setup page is right, then try again.",
  );
}, 15_000);

test("only a failure to connect is put in words; a stop and a Bot's own refusal are not", async () => {
  const refused = await fetch(`http://127.0.0.1:${closedPort}/`).catch(
    (error: unknown) => error,
  );
  expect(isUnreachable(refused)).toBe(true);
  // Node's fetch keeps the socket's code on the cause.
  expect(
    isUnreachable(
      new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } }),
    ),
  ).toBe(true);
  const controller = new AbortController();
  controller.abort();
  const stopped = await fetch(`http://127.0.0.1:${platform.port}/`, {
    signal: controller.signal,
  }).catch((error: unknown) => error);
  expect(isUnreachable(stopped)).toBe(false);
  expect(isUnreachable(new Error("HTTP 500: Internal Server Error"))).toBe(
    false,
  );
});
