import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { RunAgentInput } from "@ag-ui/client";
import { type ChatCompletionRequest, LLMock } from "@copilotkit/aimock";
import { SUBAGENT_TOOL } from "@openbot/shared/subagent";
import { RUNTIME_STATE_TOOLS } from "@openbot/toolkit/copilotkit/agents";
import type { GrantedTool } from "@openbot/toolkit/granted-tool";
import type { RunnerLike } from "@openbot/toolkit/run-turn";
import { Observable } from "rxjs";
import { z } from "zod";
import { createActorAgentResolver } from "../src/agents/agent-resolver";
import { createAgentFetch } from "../src/agents/endpoint";
import { createSubagents, SUBAGENT_HANDED_BACK } from "../src/agents/subagent";
import { serverTurnAdmission } from "../src/agents/turn-admission";
import { PERSON_INITIATOR } from "../src/audit";
import { loadConfig } from "../src/config";
import {
  mountCopilotRuntime,
  type RegisteredAgent,
  registeredAgentFromRow,
} from "../src/copilot";
import { testEnvironment } from "./support/environment";

/**
 * The runs the CopilotKit runtime makes for itself on a Bot hold none of the Bot's tools.
 *
 * The runtime names a new conversation by building the conversation's Bot again and running it
 * in-process on a title prompt, and it answers `agent/<id>/suggest` by running the Bot on whatever
 * the caller sends. Nobody asked for either and nobody sees either. Holding the Bot's tools, a
 * naming run was seen to start a subagent, which acts with every permission the Bot has, and keep
 * writing for a minute after the person pressed Stop.
 *
 * Driven through the real path: the handler `mountCopilotRuntime` returns, the real resolver
 * building a built-in Bot and a remote AG-UI Bot, the real subagent tool wired the way
 * `server/src/index.ts` wires it, and the runtime's own thread naming. The fakes are the model
 * (`@copilotkit/aimock`), the remote Bot's endpoint, and the Intelligence platform (REST and the
 * runner's Phoenix channel), all on 127.0.0.1.
 */

/**
 * How the runtime asks for a title, in its own words. Its system prompt is not used: a built-in
 * Bot's model is given the Bot's own system prompt, so only this user message reaches it.
 */
const TITLE_PROMPT = "Generate a short title for the conversation above.";
const person = { id: "colleague", name: "Colleague" };
const BUILT_IN = "planner";
const REMOTE = "remote-planner";

const realFetch = globalThis.fetch;
let environmentBefore: Record<string, string | undefined> = {};

/* ------------------------------------------------------------------------------------------------
 * What happened, as each fake saw it.
 * ---------------------------------------------------------------------------------------------- */

/** Every subagent started, by any run. A naming run must never add one. */
const subagentsStarted: { agentId: string; depth?: number }[] = [];
/** Every call of the Bot's one granted tool. */
const posted: unknown[] = [];
const modelRequests: ChatCompletionRequest[] = [];
const remoteRequests: RunAgentInput[] = [];
const named = new Map<string, string>();
const created = new Set<string>();
const delivered: { runId?: string; type?: string }[] = [];
/** How many times each kind of run has asked the model (or the endpoint) to name a thread. */
const namingCalls = { model: 0, remote: 0 };
/** Whether the first naming call asks for a subagent. */
let namingAsks = true;
/** What a person's turn on the built-in Bot asks the model to do. */
let personTurn: (request: ChatCompletionRequest) => Reply = () => ({
  content: "Here is the plan.",
});

/* ------------------------------------------------------------------------------------------------
 * The model: aimock, scripted, behind a relay that ends each response as a real provider does.
 * ---------------------------------------------------------------------------------------------- */

type Reply = {
  content?: string;
  toolCalls?: { name: string; arguments: string }[];
};
const text = (message: { content?: unknown }) =>
  typeof message.content === "string"
    ? message.content
    : JSON.stringify(message.content ?? "");
const isNaming = (messages: readonly { content?: unknown }[]) =>
  messages.some((message) => text(message).includes(TITLE_PROMPT));
const isSubagent = (messages: readonly { role: string; content?: unknown }[]) =>
  messages.some(
    (message) =>
      message.role === "user" && text(message).startsWith("You are a subagent"),
  );
const isSuggestion = (messages: readonly { content?: unknown }[]) =>
  messages.some((message) => text(message).includes("Offer the next steps."));
const answered = (messages: readonly { role: string }[]) =>
  messages.some((message) => message.role === "tool");
const offered = (request: ChatCompletionRequest) =>
  (request.tools ?? []).map((tool) => tool.function.name);
const startSubagent = {
  name: SUBAGENT_TOOL,
  arguments: JSON.stringify({
    task: "Write a detailed essay on the history of bread.",
    answer: "The essay.",
  }),
};

const llm = new LLMock({ host: "127.0.0.1", port: 0 });
let relay: ReturnType<typeof Bun.serve>;

/* ------------------------------------------------------------------------------------------------
 * The remote Bot's endpoint, and the Intelligence platform.
 * ---------------------------------------------------------------------------------------------- */

let endpoint: ReturnType<typeof Bun.serve>;
let platform: ReturnType<typeof Bun.serve>;

function sse(events: Record<string, unknown>[]) {
  return new Response(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
}
function saying(input: RunAgentInput, words: string) {
  const run = { threadId: input.threadId, runId: input.runId };
  const messageId = randomUUID();
  return sse([
    { type: "RUN_STARTED", ...run },
    { type: "TEXT_MESSAGE_START", messageId, role: "assistant" },
    { type: "TEXT_MESSAGE_CONTENT", messageId, delta: words },
    { type: "TEXT_MESSAGE_END", messageId },
    { type: "RUN_FINISHED", ...run },
  ]);
}
function calling(input: RunAgentInput, call: typeof startSubagent) {
  const run = { threadId: input.threadId, runId: input.runId };
  const toolCallId = `remote-call-${randomUUID()}`;
  return sse([
    { type: "RUN_STARTED", ...run },
    {
      type: "TOOL_CALL_START",
      toolCallId,
      toolCallName: call.name,
      parentMessageId: "remote-message",
    },
    { type: "TOOL_CALL_ARGS", toolCallId, delta: call.arguments },
    { type: "TOOL_CALL_END", toolCallId },
    { type: "RUN_FINISHED", ...run },
  ]);
}

/* ------------------------------------------------------------------------------------------------
 * One deployment, wired the way `server/src/index.ts` wires it.
 * ---------------------------------------------------------------------------------------------- */

const postNote: GrantedTool = {
  name: "post_note",
  ref: "notes/post_note",
  description: "Post a note the whole team reads.",
  parameters: z.object({ text: z.string() }),
  execute: async (args) => {
    posted.push(args);
    return "Posted.";
  },
};

/** The platform a subagent's headless turn drives, answered in memory as subagent tests do. */
const turnIntelligence = {
  getOrCreateThread: async () => undefined,
  getThreadMessages: async () => ({ messages: [] }),
  ɵacquireThreadLock: async () => undefined,
  ɵrenewThreadLock: async () => undefined,
  ɵcleanupThreadLock: async () => undefined,
};
const turnRunner: RunnerLike = {
  run: ({ agent, input }) =>
    new Observable((subscriber) => {
      agent
        .runAgent(input, { onEvent: ({ event }) => subscriber.next(event) })
        .then(
          () => subscriber.complete(),
          (error) => subscriber.error(error),
        );
    }),
  stop: async () => true,
};

const roster: RegisteredAgent[] = [];
const subagents = createSubagents({
  turn: {
    admission: serverTurnAdmission,
    intelligence: turnIntelligence,
    runner: turnRunner,
  },
  buildAgentFor: ({ ownerUserId, agentId, initiator, depth }) => {
    subagentsStarted.push({ agentId, ...(depth ? { depth } : {}) });
    return resolver.resolveAgentForActor(
      { id: ownerUserId, role: "user" },
      agentId,
      { initiator, ...(depth ? { depth } : {}), subagent: true },
    );
  },
  withdrawApprovals: async () => SUBAGENT_HANDED_BACK,
});
const resolver = createActorAgentResolver({
  loadAgents: async () => roster,
  model: { provider: "openai", defaultModel: "gpt-5.5" },
  resolveModelApiKey: async () => "test-key",
  agentFetch: createAgentFetch({ allowPrivateHosts: true }),
  // The deployment's signed statement of a run, which a remote Bot hands back to call its tools.
  signRunForActor: () => (botId, runId) => `signed:${botId}:${runId}`,
  loadToolsForActor: () => async () => [postNote],
  handoffForActor: (actorId, initiator, depth) => async (botId, input) => [
    subagents.toolForRun({
      actorId,
      botId,
      threadId: input.threadId,
      runId: input.runId,
      initiator: initiator ?? PERSON_INITIATOR,
      ...(depth ? { depth } : {}),
    }),
  ],
});
let runtime: ReturnType<typeof mountCopilotRuntime>;

async function until(done: () => boolean, what: string) {
  const deadline = Date.now() + 15_000;
  while (!done()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await Bun.sleep(10);
  }
}

/** A person's message to a Bot in a new conversation, through the runtime's run route. */
async function personAsks(botId: string, said: string) {
  const threadId = `thread-${randomUUID()}`;
  const runId = `run-${randomUUID()}`;
  const response = await runtime.handler.fetch(
    new Request(`http://127.0.0.1/api/copilotkit/agent/${botId}/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        threadId,
        runId,
        state: {},
        messages: [{ id: randomUUID(), role: "user", content: said }],
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
        (event) => event.runId === runId && event.type === "RUN_FINISHED",
      ),
    "the person's run to finish",
  );
  // The runtime names a new conversation beside the person's run, so it is waited for too.
  await until(() => named.has(threadId), "the conversation to be named");
  return { threadId, runId };
}

beforeAll(async () => {
  llm.on({ predicate: () => true }, async (request) => {
    modelRequests.push(request);
    const { messages } = request;
    if (isSubagent(messages)) return { content: "An essay nobody asked for." };
    if (isNaming(messages)) {
      namingCalls.model += 1;
      // Asks for a subagent the first time, whether or not it was offered one.
      return namingAsks && namingCalls.model === 1 && !answered(messages)
        ? { toolCalls: [startSubagent] }
        : { content: '{"title":"Offsite plan"}' };
    }
    if (isSuggestion(messages))
      return answered(messages)
        ? { content: "Nothing to suggest." }
        : { toolCalls: [startSubagent] };
    return personTurn(request);
  });
  const model = await llm.start();
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
                // The connection ends a moment after the last event, as a real provider's does.
                await Bun.sleep(25);
                controller.close();
              },
            })
          : null,
        { status: answer.status, headers: answer.headers },
      );
    },
  });

  endpoint = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const input = (await request.json()) as RunAgentInput;
      remoteRequests.push(input);
      const { messages } = input;
      if (isSubagent(messages)) return saying(input, "A remote essay.");
      if (isNaming(messages)) {
        namingCalls.remote += 1;
        return namingAsks && namingCalls.remote === 1 && !answered(messages)
          ? calling(input, startSubagent)
          : saying(input, '{"title":"Remote offsite"}');
      }
      if (isSuggestion(messages))
        return answered(messages)
          ? saying(input, "Nothing to suggest.")
          : calling(input, startSubagent);
      return saying(input, "Here is the remote plan.");
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
      const raw = await request.text();
      const body = (raw ? JSON.parse(raw) : {}) as Record<string, unknown>;
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
          ? Response.json({
              thread: { id: threadId, name: named.get(threadId) ?? null },
            })
          : Response.json({ error: "THREAD_NOT_FOUND" }, { status: 404 });
      if (threadId && rest === undefined && request.method === "PATCH") {
        named.set(threadId, String(body.name));
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

  environmentBefore = {
    OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    COPILOTKIT_TELEMETRY_DISABLED: process.env.COPILOTKIT_TELEMETRY_DISABLED,
  };
  process.env.OPENAI_BASE_URL = `http://127.0.0.1:${relay.port}/v1`;
  process.env.OPENAI_API_KEY = "test-key";
  process.env.COPILOTKIT_TELEMETRY_DISABLED = "true";

  roster.push({
    id: BUILT_IN,
    name: "Planner",
    type: "built_in",
    systemPrompt: "Plan the team's work.",
  });
  const remote = registeredAgentFromRow({
    id: REMOTE,
    name: "Remote Planner",
    type: "remote_ag_ui",
    configuration: { endpoint: `http://127.0.0.1:${endpoint.port}/ag-ui` },
    title: "Planner",
    roleDescription: "Plan the team's work.",
  });
  if (!remote) throw new Error("The remote Bot did not register.");
  roster.push(remote);

  runtime = mountCopilotRuntime(
    loadConfig(
      testEnvironment({
        INTELLIGENCE_API_URL: `http://127.0.0.1:${platform.port}`,
        INTELLIGENCE_GATEWAY_WS_URL: `ws://127.0.0.1:${platform.port}`,
      }),
    ),
    resolver,
    async () => person,
    async () => ({ id: person.id, role: "user" }),
  );
});

beforeEach(() => {
  subagentsStarted.length = 0;
  posted.length = 0;
  modelRequests.length = 0;
  remoteRequests.length = 0;
  namingCalls.model = 0;
  namingCalls.remote = 0;
  namingAsks = true;
  personTurn = () => ({ content: "Here is the plan." });
});

afterAll(async () => {
  await llm.stop();
  relay.stop(true);
  endpoint.stop(true);
  platform.stop(true);
  globalThis.fetch = realFetch;
  for (const [name, value] of Object.entries(environmentBefore)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

test("naming a new conversation holds none of a built-in Bot's tools, so it starts no subagent even when the model asks for one, and the conversation is still named", async () => {
  const { threadId } = await personAsks(BUILT_IN, "Plan the team offsite.");

  expect(subagentsStarted).toEqual([]);
  expect(
    modelRequests.filter((request) => isSubagent(request.messages)),
  ).toEqual([]);
  const naming = modelRequests.filter((request) => isNaming(request.messages));
  expect(naming.length).toBeGreaterThan(0);
  // Only the two state tools CopilotKit's own agent adds to every run: nothing of the Bot's.
  for (const request of naming)
    expect(
      offered(request).filter(
        (name) => !(RUNTIME_STATE_TOOLS as readonly string[]).includes(name),
      ),
    ).toEqual([]);
  expect(named.get(threadId)).toBe("Offsite plan");
});

test("naming a new conversation holds none of a remote Bot's tools and carries no signed run, so nothing it calls is run", async () => {
  const { threadId } = await personAsks(REMOTE, "Plan the team offsite.");

  expect(subagentsStarted).toEqual([]);
  expect(remoteRequests.filter((input) => isSubagent(input.messages))).toEqual(
    [],
  );
  const naming = remoteRequests.filter((input) => isNaming(input.messages));
  expect(naming.length).toBeGreaterThan(0);
  for (const input of naming) {
    expect(input.tools.map((tool) => tool.name)).toEqual([]);
    // Without the deployment's signed statement of the run, no callback of the Bot's is accepted.
    expect(input.forwardedProps).toMatchObject({ openbotBotId: REMOTE });
    expect(Object.hasOwn(input.forwardedProps, "openbotRun")).toBe(false);
  }
  expect(named.get(threadId)).toBe("Remote offsite");
});

test("a suggestion holds none of the Bot's tools, even when it carries everything a person's run was given", async () => {
  // What a person's run carried to the Bot, which a suggestion request copies wholesale.
  namingAsks = false;
  await personAsks(REMOTE, "Plan the team offsite.");
  const asked = remoteRequests.find(
    (input) =>
      !isNaming(input.messages) &&
      input.tools.some((tool) => tool.name === SUBAGENT_TOOL),
  );
  if (!asked) throw new Error("The person's run reached no Bot.");
  subagentsStarted.length = 0;
  modelRequests.length = 0;
  remoteRequests.length = 0;

  for (const botId of [BUILT_IN, REMOTE]) {
    const response = await runtime.handler.fetch(
      new Request(`http://127.0.0.1/api/copilotkit/agent/${botId}/suggest`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          threadId: `suggest-${randomUUID()}`,
          runId: `suggest-${randomUUID()}`,
          state: {},
          messages: [
            {
              id: randomUUID(),
              role: "user",
              content: "Offer the next steps.",
            },
          ],
          tools: [],
          context: [],
          forwardedProps: asked.forwardedProps,
        } satisfies RunAgentInput),
      }),
    );
    expect(response.status).toBe(200);
    await response.text();
  }

  expect(subagentsStarted).toEqual([]);
  expect(posted).toEqual([]);
  const suggestions = modelRequests.filter((request) =>
    isSuggestion(request.messages),
  );
  expect(suggestions.length).toBeGreaterThan(0);
  for (const request of suggestions)
    expect(
      offered(request).filter(
        (name) => !(RUNTIME_STATE_TOOLS as readonly string[]).includes(name),
      ),
    ).toEqual([]);
  const remote = remoteRequests.filter((input) => isSuggestion(input.messages));
  expect(remote.length).toBeGreaterThan(0);
  for (const input of remote) {
    expect(input.tools.map((tool) => tool.name)).toEqual([]);
    // Not even the signed run it carried in from the person's run.
    expect(input.forwardedProps).toMatchObject({ openbotBotId: REMOTE });
    expect(Object.hasOwn(input.forwardedProps, "openbotRun")).toBe(false);
  }
});

test("a person's own run still holds its grants and the subagent tool, and can start a subagent", async () => {
  namingAsks = false;
  personTurn = (request) =>
    answered(request.messages)
      ? { content: "The subagent wrote it." }
      : { toolCalls: [startSubagent] };
  await personAsks(BUILT_IN, "Plan the team offsite.");
  const builtIn = modelRequests.find(
    (request) =>
      !isNaming(request.messages) &&
      !isSubagent(request.messages) &&
      !answered(request.messages),
  );
  if (!builtIn) throw new Error("The person's run reached no model.");
  expect(offered(builtIn)).toContain(SUBAGENT_TOOL);
  expect(offered(builtIn)).toContain(postNote.name);
  expect(subagentsStarted).toEqual([{ agentId: BUILT_IN, depth: 1 }]);

  await personAsks(REMOTE, "Plan the team offsite.");
  const remote = remoteRequests.find(
    (input) => !isNaming(input.messages) && !isSubagent(input.messages),
  );
  if (!remote) throw new Error("The person's run reached no Bot.");
  expect(remote.tools.map((tool) => tool.name)).toEqual(
    expect.arrayContaining([SUBAGENT_TOOL, postNote.name]),
  );
  expect(remote.forwardedProps?.openbotRun).toBe(
    `signed:${REMOTE}:${remote.runId}`,
  );
});
