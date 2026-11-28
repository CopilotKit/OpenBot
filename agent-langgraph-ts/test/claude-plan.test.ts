/**
 * A Claude plan's model calls, through the Claude engine's `/model` endpoint.
 *
 * The plan token never leaves the Claude Agent SDK engine (agent-claude-sdk): this engine runs the
 * graph and every model call is an AG-UI run at that engine's `/model`, as the server's built-in
 * Bots on a Claude plan make it (`PlanModel` in server/src/agents/plan-model.ts). There the SDK
 * query is kept between a step's tool call and its result, so the thread id is stable per
 * (Bot, thread), and a stopped run cancels the query at `/model/cancel`.
 *
 * The fake engine answers with streams recorded from the real agent-claude-sdk image, built from
 * this repository, at its `/model` (test/fixtures/claude-model/). With `OPENBOT_LIVE_CLAUDE_URL`
 * and `OPENBOT_LIVE_CLAUDE_TOKEN` the last test runs against a real one.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  createServer,
  type IncomingHttpHeaders,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { inspect } from "node:util";
import {
  conversation,
  events,
  run,
  TOKEN,
  WEATHER_TOOL,
  withEngine,
} from "./helpers.ts";

const fixture = (name: string) =>
  readFileSync(
    new URL(`./fixtures/claude-model/${name}.sse`, import.meta.url),
    "utf8",
  );

type Recorded = {
  path: string;
  headers: IncomingHttpHeaders;
  body: Record<string, unknown>;
};

type ClaudeEngine = {
  url: string;
  requests: Recorded[];
  /** Resolves when a `/model/cancel` arrives. */
  cancelled: Promise<Recorded>;
  close: () => Promise<void>;
};

/** `answer(index)` is the stream for the index-th `/model` run, or "hang" to hold it open. */
async function claudeEngine(
  answer: (index: number) => string | "hang",
): Promise<ClaudeEngine> {
  const requests: Recorded[] = [];
  let onCancel: (recorded: Recorded) => void = () => {};
  const cancelled = new Promise<Recorded>((resolve) => (onCancel = resolve));
  const held: ServerResponse[] = [];
  let runs = 0;
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const recorded = {
      path: request.url ?? "",
      headers: request.headers,
      body: JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"),
    };
    requests.push(recorded);
    // As agent-claude-sdk's middleware: everything but /health needs the deployment's token.
    if (request.headers["x-openbot-agent-token"] !== TOKEN) {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "unauthorised" }));
      return;
    }
    if (recorded.path === "/model/cancel") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true }));
      onCancel(recorded);
      return;
    }
    // A plan engine's run: the Claude engine's at /model, the ChatGPT engine's at its root.
    if (recorded.path !== "/model" && recorded.path !== "/") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ detail: "Not Found" }));
      return;
    }
    const stream = answer(runs++);
    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
    });
    if (stream === "hang") {
      response.write(`${fixture("text").split("\n\n")[0]}\n\n`);
      held.push(response);
      return;
    }
    response.end(stream);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    cancelled,
    close: () =>
      new Promise<void>((resolve) => {
        for (const response of held) response.destroy();
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** The engine's environment under the live connection: the plan engines' addresses, no key. */
const env = (claude: string, extra: Record<string, string> = {}) => ({
  OPENBOT_MODEL_GATEWAY_URL: "http://127.0.0.1:9/api/model-provider",
  CLAUDE_PLAN_HARNESS_URL: claude,
  CHATGPT_PLAN_HARNESS_URL: "http://127.0.0.1:9/never",
  BOT_PROVIDER: "openai",
  OPENAI_API_KEY: "",
  ANTHROPIC_API_KEY: "",
  ...extra,
});

const claudeRoute = { via: "claude-plan" };

const threadOf = (botId: string, threadId: string) =>
  createHash("sha256")
    .update(JSON.stringify([botId, threadId]))
    .digest("hex");

function words(list: { type: string; delta?: unknown }[]): string {
  return list
    .filter((event) => event.type === "TEXT_MESSAGE_CONTENT")
    .map((event) => String(event.delta))
    .join("");
}

test("The claude-plan route asks the Claude engine's /model, with the deployment's token, and its words stream on", async () => {
  const claude = await claudeEngine(() => fixture("text"));
  try {
    const result = await withEngine({ env: env(claude.url) }, (base) =>
      run(
        base,
        conversation({
          tools: [WEATHER_TOOL],
          forwardedProps: {
            openbotModel: {
              model: "claude-sonnet-4-6",
              reasoningEffort: "low",
            },
            openbotModelRoute: claudeRoute,
          },
        }),
      ),
    );
    assert.equal(
      result.events.at(-1)?.type,
      "RUN_FINISHED",
      inspect(result.events.at(-1)),
    );
    assert.equal(words(result.events), "hello from the Claude plan");
    assert.equal(claude.requests.length, 1);
    const { path, headers, body } = claude.requests[0]!;
    assert.equal(path, "/model");
    assert.equal(headers["x-openbot-agent-token"], TOKEN);
    assert.equal(body.threadId, threadOf("test-bot", "thread-1"));
    assert.deepEqual(body.forwardedProps, {
      openbotModelOnly: true,
      openbotBotId: "test-bot",
      openbotModel: { model: "claude-sonnet-4-6", reasoningEffort: "low" },
    });
    const context = body.context as { description: string; value: string }[];
    assert.equal(context[0]?.description, "Built-in Bot instructions");
    assert.ok(context[0]?.value.includes("STANDING_ROLE_MARKER"));
    assert.deepEqual(
      (body.messages as { role: string }[]).map((message) => message.role),
      ["user", "assistant", "user"],
    );
    assert.deepEqual(
      (body.tools as { name: string }[]).map((tool) => tool.name),
      ["get_weather", "recall_earlier_results"],
    );
  } finally {
    await claude.close();
  }
});

/** The call in the recorded `tool` fixture, as the run that streamed it hands it back. */
function handedBack(list: { type: string; [key: string]: unknown }[]) {
  const start = list.find((event) => event.type === "TOOL_CALL_START")!;
  const args = list
    .filter(
      (event) =>
        event.type === "TOOL_CALL_ARGS" &&
        event.toolCallId === start.toolCallId,
    )
    .map((event) => String(event.delta))
    .join("");
  return {
    id: String(start.toolCallId),
    name: String(start.toolCallName),
    args,
  };
}

test("A step's tool call and the next step stay on one Claude query: the same thread, per Bot and thread", async () => {
  const claude = await claudeEngine((index) =>
    index === 0 ? fixture("tool") : fixture("text"),
  );
  try {
    const result = await withEngine({ env: env(claude.url) }, async (base) => {
      const input = conversation({
        tools: [WEATHER_TOOL],
        forwardedProps: { openbotModelRoute: claudeRoute },
      });
      const first = await run(base, input);
      // OpenBot answers the call it was handed and carries the turn on in the next run.
      const call = handedBack(first.events);
      const second = await run(base, {
        ...input,
        runId: "run-2",
        messages: [
          ...(input.messages as unknown[]),
          {
            id: "a-call",
            role: "assistant",
            content: "",
            toolCalls: [
              {
                id: call.id,
                type: "function",
                function: { name: call.name, arguments: call.args },
              },
            ],
          },
          {
            id: "t-call",
            role: "tool",
            toolCallId: call.id,
            content: "Sunny, 21 degrees.",
          },
        ],
      });
      // Another conversation of the same Bot is another Claude query.
      await run(
        base,
        conversation({
          threadId: "thread-2",
          forwardedProps: { openbotModelRoute: claudeRoute },
        }),
      );
      return second;
    });
    assert.equal(
      result.events.at(-1)?.type,
      "RUN_FINISHED",
      inspect(result.events.at(-1)),
    );
    assert.equal(claude.requests.length, 3);
    const [step1, step2, other] = claude.requests.map(
      (request) => request.body,
    );
    assert.equal(step1!.threadId, threadOf("test-bot", "thread-1"));
    assert.equal(
      step2!.threadId,
      step1!.threadId,
      "the tool result goes back to the query that asked",
    );
    assert.equal(other!.threadId, threadOf("test-bot", "thread-2"));
    const results = (
      step2!.messages as { role: string; content: string }[]
    ).filter((message) => message.role === "tool");
    assert.deepEqual(
      results.map((message) => message.content),
      ["Sunny, 21 degrees."],
    );
    assert.ok(
      !claude.requests.some((request) => request.path === "/model/cancel"),
    );
  } finally {
    await claude.close();
  }
});

/*
 * One Claude engine serves every organization. The same thread id from two organizations, for a
 * Bot of the same id, has to be two Claude queries: one query is one transcript and one set of
 * turns, and one organization would answer inside the other's. A run with no organization keeps
 * the name it always had, so a thread that already has a query keeps it.
 */
test("The same thread in two organizations is two Claude queries; with no organization the name is unchanged", async () => {
  const claude = await claudeEngine(() => fixture("text"));
  const inOrganization = (organization?: string) =>
    conversation({
      forwardedProps: {
        openbotModelRoute: claudeRoute,
        ...(organization ? { openbotOrganization: organization } : {}),
      },
    });
  try {
    await withEngine({ env: env(claude.url) }, async (base) => {
      await run(base, inOrganization("org-a"));
      await run(base, inOrganization("org-b"));
      await run(base, inOrganization());
    });
    const [a, b, none] = claude.requests.map(
      (request) => request.body.threadId,
    );
    assert.equal(claude.requests.length, 3);
    assert.notEqual(a, b);
    assert.notEqual(a, none);
    assert.notEqual(b, none);
    assert.equal(
      a,
      createHash("sha256")
        .update(JSON.stringify(["test-bot", "thread-1", "org-a"]))
        .digest("hex"),
    );
    // The name a thread's query had before organizations joined it.
    assert.equal(none, threadOf("test-bot", "thread-1"));
    for (const request of claude.requests)
      assert.equal(
        (request.body.forwardedProps as Record<string, unknown>)
          .openbotOrganization,
        undefined,
        "the organization is not sent on to the Claude engine",
      );
  } finally {
    await claude.close();
  }
});

test("A run that hands a call back to the surface keeps its Claude query for the result", async () => {
  const claude = await claudeEngine(() => fixture("tool"));
  try {
    const result = await withEngine({ env: env(claude.url) }, (base) =>
      run(
        base,
        conversation({
          tools: [WEATHER_TOOL],
          forwardedProps: { openbotModelRoute: claudeRoute },
        }),
      ),
    );
    assert.equal(result.events.at(-1)?.type, "RUN_FINISHED");
    assert.ok(result.events.some((event) => event.type === "TOOL_CALL_START"));
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(
      claude.requests.map((request) => request.path),
      ["/model"],
      "no cancel: the query waits for the surface's result",
    );
  } finally {
    await claude.close();
  }
});

test("Stopping a run cancels its Claude query at /model/cancel", async () => {
  const claude = await claudeEngine(() => "hang");
  try {
    await withEngine({ env: env(claude.url) }, async (base) => {
      const stop = new AbortController();
      const response = await fetch(`${base}/`, {
        method: "POST",
        signal: stop.signal,
        headers: {
          "content-type": "application/json",
          accept: "text/event-stream",
          "x-openbot-agent-token": TOKEN,
        },
        body: JSON.stringify(
          conversation({ forwardedProps: { openbotModelRoute: claudeRoute } }),
        ),
      });
      assert.equal(response.status, 200);
      // Wait until the model call is under way, then Stop.
      const until = Date.now() + 5000;
      while (
        !claude.requests.some((request) => request.path === "/model") &&
        Date.now() < until
      )
        await new Promise((resolve) => setTimeout(resolve, 10));
      assert.ok(
        claude.requests.some((request) => request.path === "/model"),
        "the model call reached the Claude engine",
      );
      stop.abort();
      const cancel = await Promise.race([
        claude.cancelled,
        new Promise<undefined>((resolve) => setTimeout(resolve, 5000)),
      ]);
      assert.ok(cancel, "the Claude engine was told to cancel");
      assert.equal(cancel.headers["x-openbot-agent-token"], TOKEN);
      assert.deepEqual(cancel.body, {
        threadId: threadOf("test-bot", "thread-1"),
      });
    });
  } finally {
    await claude.close();
  }
});

test("The chatgpt-plan route goes to the ChatGPT plan's engine, a fresh thread per call", async () => {
  const chatgpt = await claudeEngine(() => fixture("text"));
  try {
    const result = await withEngine(
      {
        env: env("http://127.0.0.1:9/never", {
          CHATGPT_PLAN_HARNESS_URL: chatgpt.url,
        }),
      },
      (base) =>
        run(
          base,
          conversation({
            forwardedProps: {
              openbotModel: { model: "gpt-5.5" },
              openbotModelRoute: { via: "chatgpt-plan" },
            },
          }),
        ),
    );
    assert.equal(
      result.events.at(-1)?.type,
      "RUN_FINISHED",
      inspect(result.events.at(-1)),
    );
    // The ChatGPT engine's run is at its root, on a thread of its own.
    assert.deepEqual(
      chatgpt.requests.map((request) => request.path),
      ["/"],
    );
    assert.match(String(chatgpt.requests[0]!.body.threadId), /^plan-/);
  } finally {
    await chatgpt.close();
  }
});

test("A plan route with no address for that plan's engine says so in words", async () => {
  const result = await withEngine(
    { env: { ...env(""), CLAUDE_PLAN_HARNESS_URL: "" } },
    (base) =>
      run(
        base,
        conversation({ forwardedProps: { openbotModelRoute: claudeRoute } }),
      ),
  );
  const error = result.events.at(-1)!;
  assert.equal(error.type, "RUN_ERROR");
  assert.match(String(error.message), /Claude/);
});

const LIVE_URL = process.env.OPENBOT_LIVE_CLAUDE_URL?.trim();
const LIVE_TOKEN = process.env.OPENBOT_LIVE_CLAUDE_TOKEN?.trim();

test("Live: a real Claude engine answers the claude-plan route through /model, a tool handed back between two runs", {
  skip:
    !LIVE_URL || !LIVE_TOKEN ? "set OPENBOT_LIVE_CLAUDE_URL and _TOKEN" : false,
}, async () => {
  const send = async (base: string, body: Record<string, unknown>) => {
    const response = await fetch(`${base}/`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "text/event-stream",
        "x-openbot-agent-token": LIVE_TOKEN!,
      },
      body: JSON.stringify(body),
    });
    return events(await response.text());
  };
  const thread = [
    {
      id: "standing-role:live-bot",
      role: "system",
      content:
        "You are a terse test Bot. Use get_weather for weather questions.",
    },
    {
      id: "u1",
      role: "user",
      content: "What's the weather in Paris? Use the tool.",
    },
  ];
  const input = conversation({
    threadId: `live-${Date.now()}`,
    messages: thread,
    tools: [WEATHER_TOOL],
    forwardedProps: { openbotModelRoute: claudeRoute },
  });
  const [first, second] = await withEngine(
    { env: { ...env(LIVE_URL!), MANAGED_AGENT_TOKEN: LIVE_TOKEN! } },
    async (base) => {
      const first = await send(base, input);
      assert.equal(first.at(-1)?.type, "RUN_FINISHED", inspect(first.at(-1)));
      const call = handedBack(first);
      assert.equal(call.name, "get_weather");
      const second = await send(base, {
        ...input,
        runId: "run-2",
        messages: [
          ...thread,
          {
            id: "a-call",
            role: "assistant",
            content: "",
            toolCalls: [
              {
                id: call.id,
                type: "function",
                function: { name: call.name, arguments: call.args },
              },
            ],
          },
          {
            id: "t-call",
            role: "tool",
            toolCallId: call.id,
            content: "Paris: sunny, 21 degrees Celsius.",
          },
        ],
      });
      return [first, second];
    },
  );
  assert.ok(first.some((event) => event.type === "TOOL_CALL_END"));
  assert.equal(second.at(-1)?.type, "RUN_FINISHED", inspect(second.at(-1)));
  assert.match(words(second), /21/);
});
