import { afterAll, beforeAll, expect, test } from "bun:test";
import type { RunAgentInput } from "@ag-ui/client";
import { createActorAgentResolver } from "../src/agents/agent-resolver";
import {
  agentAuthHeaders,
  authFromConfiguration,
} from "../src/agents/auth-header";
import { createAgentFetch } from "../src/agents/endpoint";
import { loadConfig } from "../src/config";
import { mountCopilotRuntime, registeredAgentFromRow } from "../src/copilot";
import { encryptSecret } from "../src/credentials";
import { testEnvironment } from "./support/environment";

/**
 * What a person's request carries never reaches a Bot's endpoint; what the Bot itself holds does.
 *
 * The runtime forwards `authorization` and every `x-*` header from the request that started a run
 * onto the agent it runs, unless it is told otherwise. For a remote Bot that is a POST to whatever
 * address the Bot's author registered, and anyone allowed to publish a Bot can register their own.
 * A colleague signed in with an Entra bearer who chats with that Bot would hand the author their
 * token, which OpenBot itself accepts for as long as it lives.
 *
 * Driven through the real path: the handler `mountCopilotRuntime` returns, a Bot built from a stored
 * row with its key read out of the vault the way the runtime loader reads it, OpenBot's own guarded
 * fetch, and a real AG-UI endpoint on a socket that writes down every header it was sent. The
 * Intelligence platform underneath is a small fake on the same terms, REST and the runner's Phoenix
 * channel, acknowledging what a healthy platform acknowledges, because a run in OpenBot only starts
 * once the platform has locked the thread and the runner has joined.
 */

const ENCRYPTION_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const LEAKED_BEARER = "Bearer leak-me";

/** The headers a Bot's endpoint saw, one entry per request, keyed by which Bot it was. */
const seen: { bot: string; headers: Record<string, string | undefined> }[] = [];
/** AG-UI events the runner delivered to the platform, so a run can be awaited to its end. */
const delivered: { runId?: string; type?: string }[] = [];
/** Anything the platform was asked that this fake does not answer: a hint, if a run stalls. */
const unanswered: string[] = [];

let endpoint: ReturnType<typeof Bun.serve>;
let platform: ReturnType<typeof Bun.serve>;

beforeAll(() => {
  endpoint = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const bot = new URL(request.url).pathname.split("/")[1] ?? "";
      seen.push({ bot, headers: Object.fromEntries(request.headers) });
      const input = (await request.json()) as RunAgentInput;
      const events = [
        { type: "RUN_STARTED", threadId: input.threadId, runId: input.runId },
        { type: "TEXT_MESSAGE_START", messageId: "reply", role: "assistant" },
        { type: "TEXT_MESSAGE_CONTENT", messageId: "reply", delta: "Hello." },
        { type: "TEXT_MESSAGE_END", messageId: "reply" },
        { type: "RUN_FINISHED", threadId: input.threadId, runId: input.runId },
      ];
      return new Response(
        events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });

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
          return Response.json({
            thread: { id: threadId, name: "Forwarded headers" },
          });
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
      unanswered.push(`${request.method} ${url.pathname}`);
      return Response.json({ error: "not found" }, { status: 404 });
    },
    websocket: {
      // Every push is acknowledged, as a platform that stored it would: the join, each event, the
      // heartbeat and the leave.
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
  endpoint.stop(true);
  platform.stop(true);
});

/**
 * A remote Bot as the runtime loader produces it: the stored row, then its key decrypted from the
 * vault under the header name its author chose (agents/runtime-agents.ts).
 */
async function remoteBot(id: string, header: string, key: string) {
  const configuration = {
    endpoint: `http://127.0.0.1:${endpoint.port}/${id}/ag-ui`,
    auth: { header, credentialId: `${id}-credential` },
  };
  const agent = registeredAgentFromRow({
    id,
    name: id,
    type: "remote_ag_ui",
    configuration,
    title: "Someone else's Bot",
    roleDescription: "Answer whoever asks.",
  });
  if (agent?.type !== "remote_ag_ui")
    throw new Error(`${id} did not parse as a remote Bot`);
  const encryptedValue = await encryptSecret(ENCRYPTION_KEY, key);
  const headers = await agentAuthHeaders({
    reader: { readSecret: async () => ({ encryptedValue, revokedAt: null }) },
    encryptionKey: ENCRYPTION_KEY,
    auth: authFromConfiguration(configuration),
  });
  if (headers) agent.headers = headers;
  return agent;
}

function mount(bots: Awaited<ReturnType<typeof remoteBot>>[]) {
  const config = loadConfig(
    testEnvironment({
      INTELLIGENCE_API_URL: `http://127.0.0.1:${platform.port}`,
      INTELLIGENCE_GATEWAY_WS_URL: `ws://127.0.0.1:${platform.port}`,
    }),
  );
  const person = { id: "colleague", name: "Colleague" };
  return mountCopilotRuntime(
    config,
    createActorAgentResolver({
      model: { provider: "openai", defaultModel: "unused" },
      loadAgents: async () => bots,
      resolveModelApiKey: async () => null,
      // The fetch production dials a remote Bot with, allowed onto loopback for this endpoint.
      agentFetch: createAgentFetch({ allowPrivateHosts: true }),
    }),
    async () => person,
    async () => ({ id: person.id, role: "user" }),
  );
}

/** A request the way an Entra client app sends one, plus an application header of its own. */
function inbound(path: string, runId: string) {
  return new Request(`http://127.0.0.1/api/copilotkit${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: LEAKED_BEARER,
      "x-leak": "1",
    },
    body: JSON.stringify({
      threadId: `thread-${runId}`,
      runId,
      state: {},
      messages: [{ id: `ask-${runId}`, role: "user", content: "Hello?" }],
      tools: [],
      context: [],
      forwardedProps: {},
    } satisfies RunAgentInput),
  });
}

async function until(done: () => boolean, what: string) {
  const deadline = Date.now() + 10_000;
  while (!done()) {
    if (Date.now() > deadline)
      throw new Error(
        `Timed out waiting for ${what}. Unanswered platform calls: ${unanswered.join(", ") || "none"}`,
      );
    await Bun.sleep(10);
  }
}

test("a run sends a remote Bot its own key, and none of the request's headers", async () => {
  const runtime = mount([
    await remoteBot("keyed", "x-api-key", "the-bot's-own-key"),
    await remoteBot("bearer", "Authorization", "Bearer the-bot's-own-token"),
  ]);

  for (const bot of ["keyed", "bearer"]) {
    const runId = `run-${bot}`;
    const response = await runtime.handler.fetch(
      inbound(`/agent/${bot}/run`, runId),
    );
    expect(response.status).toBe(200);
    await until(
      () =>
        delivered.some(
          (event) => event.runId === runId && event.type === "RUN_FINISHED",
        ),
      `${bot}'s run to finish`,
    );
  }

  const keyed = seen.filter((request) => request.bot === "keyed");
  expect(keyed).toHaveLength(1);
  expect(keyed[0]?.headers["x-api-key"]).toBe("the-bot's-own-key");
  // Mapped rather than `keyed[0]?.`, so a request that never arrived fails here instead of passing:
  // no request is `[]`, a leaked header is its value, and only an absent header is `[null]`.
  expect(keyed.map((request) => request.headers.authorization ?? null)).toEqual(
    [null],
  );
  expect(keyed.map((request) => request.headers["x-leak"] ?? null)).toEqual([
    null,
  ]);

  const bearer = seen.filter((request) => request.bot === "bearer");
  expect(bearer).toHaveLength(1);
  expect(bearer[0]?.headers.authorization).toBe("Bearer the-bot's-own-token");
  expect(bearer.map((request) => request.headers["x-leak"] ?? null)).toEqual([
    null,
  ]);
});

test("a suggestion sends a remote Bot its own key, and none of the request's headers", async () => {
  const runtime = mount([
    await remoteBot("suggesting", "x-api-key", "the-bot's-own-key"),
  ]);

  const response = await runtime.handler.fetch(
    inbound("/agent/suggesting/suggest", "suggest-run"),
  );
  expect(response.status).toBe(200);
  // The suggestion streams back on the response itself, so reading it to the end is the run.
  expect(await response.text()).toContain("RUN_FINISHED");

  const suggesting = seen.filter((request) => request.bot === "suggesting");
  expect(suggesting).toHaveLength(1);
  expect(suggesting[0]?.headers["x-api-key"]).toBe("the-bot's-own-key");
  expect(
    suggesting.map((request) => request.headers.authorization ?? null),
  ).toEqual([null]);
  expect(
    suggesting.map((request) => request.headers["x-leak"] ?? null),
  ).toEqual([null]);
});
