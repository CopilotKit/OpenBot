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
/** Somebody's own agent, registered by its address. */
const REMOTE = "remote-planner";
/** A harness this deployment runs itself, holding the deployment's token. */
const HARNESS = "harness-planner";
const MANAGED_AGENT_TOKEN = "deployment-token";

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
/** Each request the endpoint received, as the bytes it was sent. */
const remoteBodies: string[] = [];
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
async function personAsks(
  botId: string,
  said: string,
  forwardedProps: Record<string, unknown> = {},
) {
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
        forwardedProps,
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
  // The runtime once named a new conversation beside the person's run, as a run of its own started
  // as the thread was made. Long enough for one to reach the model or the endpoint, had it started.
  await new Promise((resolve) => setTimeout(resolve, NAMING_WINDOW_MS));
  return { threadId, runId };
}

/** How long after a person's run a title run would have reached the model or the endpoint. */
const NAMING_WINDOW_MS = 300;

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
      const body = await request.text();
      const input = JSON.parse(body) as RunAgentInput;
      remoteRequests.push(input);
      remoteBodies.push(body);
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
    MANAGED_AGENT_TOKEN: process.env.MANAGED_AGENT_TOKEN,
  };
  process.env.MANAGED_AGENT_TOKEN = MANAGED_AGENT_TOKEN;
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
  const harness = registeredAgentFromRow({
    id: HARNESS,
    name: "Harness Planner",
    type: "remote_ag_ui",
    configuration: { endpoint: `http://127.0.0.1:${endpoint.port}/ag-ui` },
    title: "Planner",
    roleDescription: "Plan the team's work.",
  });
  if (harness?.type !== "remote_ag_ui")
    throw new Error("The harness Bot did not register.");
  // What `runtime-agents.ts` attaches to an endpoint this deployment runs.
  harness.headers = { "x-openbot-agent-token": MANAGED_AGENT_TOKEN };
  roster.push(harness);

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
  remoteBodies.length = 0;
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

/*
 * A NEW CONVERSATION'S FIRST MESSAGE IS ONE RUN. The runtime used to name a new thread by running
 * the conversation's Bot again on a title prompt, beside the person's run. On a harness this
 * deployment runs, that was a second run on the harness at the same moment, on every first message,
 * and the person's answer came back garbled where the two overlapped. OpenBot names conversations
 * itself (`channels/summary.ts`), so the runtime's naming is off: no title run reaches any Bot.
 */
test("a harness Bot's first message reaches the harness exactly once: no title run beside it", async () => {
  const { threadId } = await personAsks(HARNESS, "Plan the team offsite.");

  expect(remoteRequests).toHaveLength(1);
  expect(remoteRequests[0]?.threadId).toBe(threadId);
  expect(remoteRequests.filter((input) => isNaming(input.messages))).toEqual(
    [],
  );
  expect(named.has(threadId)).toBe(false);
});

test("somebody's own agent gets the person's one run, and no title run on the deployment's model either", async () => {
  const { threadId } = await personAsks(REMOTE, "Plan the team offsite.");

  expect(remoteRequests).toHaveLength(1);
  expect(remoteRequests.filter((input) => isNaming(input.messages))).toEqual(
    [],
  );
  expect(modelRequests.filter((request) => isNaming(request.messages))).toEqual(
    [],
  );
  expect(named.has(threadId)).toBe(false);
});

test("a built-in Bot's first message asks the model once, with no title run, so nothing can start a subagent nobody asked for", async () => {
  const { threadId } = await personAsks(BUILT_IN, "Plan the team offsite.");

  expect(modelRequests.filter((request) => isNaming(request.messages))).toEqual(
    [],
  );
  expect(subagentsStarted).toEqual([]);
  expect(named.has(threadId)).toBe(false);
});

test("a turn sends the endpoint the component catalog once, as the guide, and not the browser's envelope as well", async () => {
  namingAsks = false;
  // The envelope the browser sends with every run, cut to one component that says where it went.
  const marker = "CATALOG-MARKER: one line of text.";
  const envelope = {
    "1.0": {
      supportedCatalogIds: ["openbot/ui@1"],
      inlineCatalogs: [
        {
          catalogId: "openbot/ui@1",
          protocolVersion: "1.0",
          components: {
            Text: {
              description: marker,
              props: {
                type: "object",
                properties: { text: { type: "string" } },
                required: ["text"],
              },
            },
          },
          functions: {},
        },
      ],
    },
    metadata: {
      extensions: {
        copilotkit_format: 3,
        copilotkit_transport: "tool",
        copilotkit_targets: [{ id: "chat", kind: "chat" }],
        copilotkit_surfaces: {},
        copilotkit_contextSent: false,
      },
    },
  };
  await personAsks(REMOTE, "Plan the team offsite.", {
    copilotkit: { ui: envelope },
  });

  const index = remoteRequests.findIndex((input) => !isNaming(input.messages));
  const turn = remoteRequests[index];
  const body = remoteBodies[index];
  if (!turn || body === undefined) throw new Error("No turn reached the Bot.");
  // What the Bot needs to draw: the render tool, and the guide naming the component.
  expect(turn.tools.map((tool) => tool.name)).toContain("render_ui");
  expect(
    turn.context.some(
      (entry) =>
        entry.description.startsWith("Generative UI guide") &&
        entry.value.includes(marker),
    ),
  ).toBe(true);
  // And the catalog only that once: the envelope it was built from stays with the runtime.
  expect(Object.hasOwn(turn.forwardedProps, "copilotkit")).toBe(false);
  expect(body.split(marker).length - 1).toBe(1);
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
  // Somebody's own agent is not run for one at all: the deployment's model answered both.
  expect(
    remoteRequests.filter((input) => isSuggestion(input.messages)),
  ).toEqual([]);
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
