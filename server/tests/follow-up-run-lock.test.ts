import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { RunAgentInput } from "@ag-ui/client";
import { type ChatCompletionRequest, LLMock } from "@copilotkit/aimock";
import { createActorAgentResolver } from "../src/agents/agent-resolver";
import { createStallGuard } from "../src/channels/stall-guard";
import { loadConfig } from "../src/config";
import { mountCopilotRuntime, type RegisteredAgent } from "../src/copilot";
import { testEnvironment } from "./support/environment";

/**
 * A Bot that runs three shell commands in a row, each one a follow-up run, on two replicas.
 *
 * Found on a fresh Helm install: General Assistant ran two of three commands and stopped, with no
 * third command and no answer. A Bot's computer tools run in the browser, so every command ends the
 * run, and the browser starts the next run with the result at once. The platform releases a run's
 * lock a moment after the run finishes, so the follow-up asked for the lock while the run before it
 * still held it, got Intelligence's retryable 409 THREAD_LOCK_FAILED, the runtime answered the
 * browser 409, and the browser gave up (AgentThreadLockedError). The base client never waited on it
 * either; the run before just usually let go in time.
 *
 * The runtime now holds a run's lock until the run's last events and lets go of it itself when the
 * run ends (CopilotKit #8236), so the follow-up finds the conversation free. What must hold either
 * way: every follow-up runs, and no run leaves the conversation locked behind it.
 *
 * Real: the runtime as copilot.ts mounts it, twice, its run route, the built-in Bot, the runner
 * streaming over the platform's Phoenix socket. Faked: the model (`@copilotkit/aimock`), and the
 * platform, whose lock is held by one run at a time and let go `RELEASE_LAG_MS` after that run's
 * RUN_FINISHED reaches it, answering with its own THREAD_LOCK_FAILED envelope meanwhile, and let go
 * at once when the run releases it itself.
 */

const RELEASE_LAG_MS = 400;
const person = { id: "dev-local-user", name: "Dev" };
const BOT = "general-assistant";
const COMMANDS = ["uname -a", "whoami", "df -h"];
const FINAL = "All three ran: Linux, pwuser, and the disk is 40% full.";
const TITLE_PROMPT = "Generate a short title for the conversation above.";

const realFetch = globalThis.fetch;
const llm = new LLMock({ host: "127.0.0.1", port: 0 });
let relay: ReturnType<typeof Bun.serve>;
let platform: ReturnType<typeof Bun.serve>;
const guard = createStallGuard({ stallMs: 0 });
let environmentBefore: Record<string, string | undefined> = {};

/** Every event the runner published, as the platform received it. */
const delivered: Record<string, unknown>[] = [];
/** The run holding each thread's lock, and every run that let go of its own while it held it. */
const holders = new Map<string, string>();
const released: string[] = [];
const created = new Set<string>();

const shell = {
  name: "run_shell",
  description: "Run one shell command on the computer and return its output.",
  parameters: {
    type: "object",
    properties: { command: { type: "string" } },
    required: ["command"],
  },
};

function toolResults(request: ChatCompletionRequest): number {
  return request.messages.filter((message) => message.role === "tool").length;
}

async function until(done: () => boolean, what: string) {
  const deadline = Date.now() + 15_000;
  while (!done()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await Bun.sleep(5);
  }
}

beforeAll(async () => {
  llm.on({ predicate: () => true }, async (request) => {
    const said = JSON.stringify(request.messages);
    if (said.includes(TITLE_PROMPT)) return { content: '{"title":"Shell"}' };
    const done = toolResults(request);
    return done < COMMANDS.length
      ? {
          toolCalls: [
            {
              name: shell.name,
              arguments: JSON.stringify({ command: COMMANDS[done] }),
            },
          ],
        }
      : { content: FINAL };
  });
  const model = await llm.start();
  // Ends each response a moment after its last byte, as a real provider's connection does.
  relay = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const answer = await realFetch(
        new URL(`${url.pathname}${url.search}`, model),
        {
          method: request.method,
          headers: request.headers,
          body: await request.text(),
        },
      );
      const body = answer.body?.getReader();
      return new Response(
        body
          ? new ReadableStream({
              async pull(controller) {
                const { done, value } = await body.read();
                if (!done) return controller.enqueue(value);
                await Bun.sleep(25);
                controller.close();
              },
            })
          : null,
        { status: answer.status, headers: answer.headers },
      );
    },
  });

  type Frame = [string | null, string | null, string, string, unknown];
  const finished = (event: Record<string, unknown>) => {
    delivered.push(event);
    if (event.type !== "RUN_FINISHED" && event.type !== "RUN_ERROR") return;
    const { runId } = event as { runId?: string };
    // The platform lets go of the lock a moment after the run's end reaches it.
    setTimeout(() => {
      for (const [thread, holder] of holders)
        if (holder === runId) holders.delete(thread);
    }, RELEASE_LAG_MS);
  };
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
      const raw = await request.text();
      const body = (raw ? JSON.parse(raw) : {}) as Record<string, unknown>;
      const [, api, threads, threadId, rest] = url.pathname.split("/");
      if (api !== "api" || threads !== "threads")
        return Response.json({ error: "not found" }, { status: 404 });
      if (!threadId && request.method === "POST") {
        created.add(String(body.threadId));
        return Response.json(
          { thread: { id: body.threadId, name: null } },
          { status: 201 },
        );
      }
      if (threadId && rest === undefined && request.method === "GET")
        return created.has(threadId)
          ? Response.json({ thread: { id: threadId, name: null } })
          : Response.json(
              {
                error: {
                  code: "THREAD_NOT_FOUND",
                  message: "Thread not found.",
                  category: "not_found",
                  retryable: false,
                },
              },
              { status: 404 },
            );
      if (threadId && rest === undefined && request.method === "PATCH")
        return Response.json({ thread: { id: threadId, name: body.name } });
      if (rest === "messages") return Response.json({ messages: [] });
      if (rest === "lock" && request.method === "POST") {
        const holder = holders.get(threadId as string);
        if (holder && holder !== body.runId) {
          return Response.json(
            {
              error: {
                code: "THREAD_LOCK_FAILED",
                message: "Thread is already locked by another runner.",
                category: "conflict",
                retryable: true,
              },
            },
            { status: 409 },
          );
        }
        holders.set(threadId as string, String(body.runId));
        return Response.json({
          threadId,
          runId: body.runId,
          joinToken: "join-token",
          ttlSeconds: 20,
        });
      }
      if (rest === "lock" && request.method === "PATCH")
        return Response.json({ ttlSeconds: 20 });
      if (rest === "lock" && request.method === "DELETE") {
        if (holders.get(threadId as string) === body.runId) {
          holders.delete(threadId as string);
          released.push(String(body.runId));
        }
        return new Response(null, { status: 204 });
      }
      return Response.json({ error: "not found" }, { status: 404 });
    },
    websocket: {
      message(socket, message) {
        const [joinRef, ref, topic, event, payload] = JSON.parse(
          String(message),
        ) as Frame;
        if (event === "event") finished(payload as Record<string, unknown>);
        if (event === "events")
          for (const one of (payload as { events?: Record<string, unknown>[] })
            .events ?? [])
            finished(one);
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

  environmentBefore = {
    OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    COPILOTKIT_TELEMETRY_DISABLED: process.env.COPILOTKIT_TELEMETRY_DISABLED,
  };
  process.env.OPENAI_BASE_URL = `http://127.0.0.1:${relay.port}/v1`;
  process.env.OPENAI_API_KEY = "test-key";
  process.env.COPILOTKIT_TELEMETRY_DISABLED = "true";
});

afterAll(async () => {
  await llm.stop();
  relay.stop(true);
  platform.stop(true);
  guard.stop();
  for (const [name, value] of Object.entries(environmentBefore)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

/** One replica: the runtime, mounted the way index.ts mounts it, against the shared platform. */
function replica() {
  const roster: RegisteredAgent[] = [
    {
      id: BOT,
      name: "General Assistant",
      type: "built_in",
      systemPrompt: "Run what the person asks on the computer.",
    },
  ];
  return mountCopilotRuntime(
    loadConfig(
      testEnvironment({
        INTELLIGENCE_API_URL: `http://127.0.0.1:${platform.port}`,
        INTELLIGENCE_GATEWAY_WS_URL: `ws://127.0.0.1:${platform.port}`,
      }),
    ),
    createActorAgentResolver({
      loadAgents: async () => roster,
      model: { provider: "openai", defaultModel: "gpt-5.5" },
      resolveModelApiKey: async () => "test-key",
      stallGuard: guard,
    }),
    async () => person,
    async () => ({ id: person.id, role: "admin" }),
  );
}

test("three commands in a row, each a follow-up run on the other replica, all run and the Bot answers", async () => {
  const replicas = [replica(), replica()];
  const threadId = randomUUID();
  const messages: Record<string, unknown>[] = [
    {
      id: randomUUID(),
      role: "user",
      content: "Run uname -a, whoami and df -h.",
    },
  ];
  const ran: string[] = [];
  const runs: string[] = [];
  let answer = "";
  for (let turn = 0; turn < COMMANDS.length + 1; turn++) {
    const runId = randomUUID();
    runs.push(runId);
    const from = delivered.length;
    // The browser, which runs the computer tool and starts the next run with its result at once.
    const response = await replicas[turn % 2]?.handler.fetch(
      new Request(`http://127.0.0.1/api/copilotkit/agent/${BOT}/run`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          threadId,
          runId,
          state: {},
          messages,
          tools: [shell],
          context: [],
          forwardedProps: {},
        } as unknown as RunAgentInput),
      }),
    );
    expect([turn, response?.status]).toEqual([turn, 200]);
    await until(
      () =>
        delivered
          .slice(from)
          .some(
            (event) =>
              event.runId === runId &&
              (event.type === "RUN_FINISHED" || event.type === "RUN_ERROR"),
          ),
      `run ${turn} to finish`,
    );
    const events = delivered.slice(from);
    const call = events.find((event) => event.type === "TOOL_CALL_START") as
      | { toolCallId: string; toolCallName: string }
      | undefined;
    if (!call) {
      answer = events
        .filter((event) => event.type === "TEXT_MESSAGE_CONTENT")
        .map((event) => String(event.delta ?? ""))
        .join("");
      break;
    }
    const args = events
      .filter(
        (event) =>
          event.type === "TOOL_CALL_ARGS" &&
          event.toolCallId === call.toolCallId,
      )
      .map((event) => String(event.delta ?? ""))
      .join("");
    const { command } = JSON.parse(args) as { command: string };
    ran.push(command);
    messages.push(
      {
        id: randomUUID(),
        role: "assistant",
        toolCalls: [
          {
            id: call.toolCallId,
            type: "function",
            function: { name: call.toolCallName, arguments: args },
          },
        ],
      },
      {
        id: randomUUID(),
        role: "tool",
        toolCallId: call.toolCallId,
        content: `ran ${command}`,
      },
    );
  }
  expect(ran).toEqual(COMMANDS);
  expect(answer).toBe(FINAL);
  // Every run let go of the conversation itself when it ended, while it still held it, and nothing
  // holds it now.
  await until(
    () => runs.every((runId) => released.includes(runId)),
    "every run to release its own lock",
  );
  expect(released).toEqual(runs);
  expect(holders.has(threadId)).toBe(false);
}, 30_000);
