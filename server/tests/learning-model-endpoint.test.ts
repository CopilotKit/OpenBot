/**
 * The Learning agent of local Intelligence, thinking on the person's Claude or ChatGPT plan through
 * OpenBot (`learning/model-endpoint.ts`).
 *
 * The caller is the real client: `@earendil-works/pi-ai` 1.4.0, the version the Learning agent
 * pins, registered exactly as Intelligence registers a compatible endpoint
 * (`libs/learning-agent/src/model.ts`, `registerCompatibleProvider`, Chat Completions). The plan's
 * harness is faked at its AG-UI boundary as `plan-model.test.ts` fakes it: the events the harnesses
 * emit, behind the deployment's agent token.
 */
import { afterEach, expect, test } from "bun:test";
import {
  type AssistantMessage,
  type Context,
  createModels,
  createProvider,
  type Model,
  Type,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { Hono } from "hono";
import {
  createLearningModelCalls,
  LEARNING_MODEL_ROUTE,
  type LearningModelCalls,
  learningModelEndpointFor,
  mountLearningModelEndpoint,
} from "../src/learning/model-endpoint";
import { runFailure } from "../src/learning/review";
import { clearDesktopConnectionFailure } from "../src/desktop-connection-failure";

const LEARNING_SECRET = "per-install-learning-secret";
const DEPLOYMENT_TOKEN = "deployment-agent-token";

type HarnessRun = {
  token: string | null;
  path: string;
  body: {
    threadId: string;
    messages: { role: string; content?: unknown; toolCalls?: unknown }[];
    tools: { name: string; parameters: unknown }[];
    context: { value: string }[];
    forwardedProps: Record<string, unknown>;
  };
};

const stops: (() => void)[] = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  // A refused sign-in is recorded for Desktop process-wide (`plan-model.ts`), and the suites share
  // this process: left set, the next suite to read the connection failure reads this one.
  clearDesktopConnectionFailure("model");
});

/** The plan's harness: one scripted answer per model step, as AG-UI events. */
function planHarness(steps: Record<string, unknown>[][]) {
  const runs: HarnessRun[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const path = new URL(request.url).pathname;
      if (path.endsWith("/cancel")) return Response.json({ ok: true });
      const body = (await request.json()) as HarnessRun["body"] & {
        runId: string;
      };
      runs.push({
        token: request.headers.get("x-openbot-agent-token"),
        path,
        body,
      });
      if (request.headers.get("x-openbot-agent-token") !== DEPLOYMENT_TOKEN)
        return new Response("refused", { status: 401 });
      const events = [
        { type: "RUN_STARTED", threadId: body.threadId, runId: body.runId },
        ...(steps[runs.length - 1] ?? []),
        { type: "RUN_FINISHED", threadId: body.threadId, runId: body.runId },
      ];
      return new Response(
        events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  stops.push(() => server.stop(true));
  return { runs, url: server.url };
}

/** OpenBot's server with the Learning endpoint, on the plan whose harness is at `harness`. */
function openBot(
  provider: "chatgpt" | "claude",
  harness: URL,
  calls?: LearningModelCalls,
) {
  const app = new Hono();
  const endpoint = new URL(harness);
  if (provider === "claude") endpoint.pathname = "/model";
  mountLearningModelEndpoint(
    app,
    learningModelEndpointFor(
      { provider, endpoint, token: DEPLOYMENT_TOKEN },
      LEARNING_SECRET,
      calls,
    ),
  );
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: app.fetch,
  });
  stops.push(() => server.stop(true));
  return `http://127.0.0.1:${server.port}/api/learning-model/v1`;
}

/** The Learning agent's model, registered the way Intelligence registers a compatible endpoint. */
function learningAgent(baseUrl: string, apiKey: string, id: string) {
  const models = createModels();
  models.setProvider(
    createProvider<"openai-completions">({
      id: "openbot",
      auth: {
        apiKey: {
          name: "Learning endpoint credential",
          resolve: async () => ({ auth: { apiKey } }),
        },
      },
      models: [
        {
          id,
          name: id,
          provider: "openbot",
          api: "openai-completions",
          baseUrl,
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 272_000,
          maxTokens: 128_000,
        },
      ],
      api: { "openai-completions": openAICompletionsApi() },
    }),
  );
  const model = models.getModel("openbot", id) as Model<"openai-completions">;
  return (context: Context) => models.complete(model, context);
}

const submit = {
  name: "submit_learning_result",
  description: "Submit the complete structured Learning result.",
  parameters: Type.Object({ insights: Type.Array(Type.String()) }),
};

const context = (): Context => ({
  systemPrompt: "Find insights in these conversations.",
  messages: [
    {
      role: "user",
      content: "Thread 1: the refund took three tries.",
      timestamp: Date.now(),
    },
  ],
  tools: [submit],
});

for (const provider of ["chatgpt", "claude"] as const) {
  test(`on a ${provider} plan, a Learning step is answered by the plan's harness, tool calls and all`, async () => {
    const harness = planHarness([
      [
        {
          type: "TOOL_CALL_START",
          toolCallId: "call-1",
          toolCallName: "submit_learning_result",
        },
        {
          type: "TOOL_CALL_ARGS",
          toolCallId: "call-1",
          delta: '{"insights":["Refunds',
        },
        {
          type: "TOOL_CALL_ARGS",
          toolCallId: "call-1",
          delta: ' need three tries"]}',
        },
        { type: "TOOL_CALL_END", toolCallId: "call-1" },
      ],
      [
        { type: "TEXT_MESSAGE_START", messageId: "m", role: "assistant" },
        { type: "TEXT_MESSAGE_CONTENT", messageId: "m", delta: "Recorded." },
        { type: "TEXT_MESSAGE_END", messageId: "m" },
      ],
    ]);
    const ask = learningAgent(
      openBot(provider, harness.url),
      LEARNING_SECRET,
      `${provider}-plan`,
    );

    const conversation = context();
    const first = await ask(conversation);
    expect(first.errorMessage).toBeUndefined();
    expect(first.stopReason).toBe("toolUse");
    expect(first.content).toContainEqual(
      expect.objectContaining({
        type: "toolCall",
        id: "call-1",
        name: "submit_learning_result",
        arguments: { insights: ["Refunds need three tries"] },
      }),
    );

    // The step went to the plan's own harness, with the deployment's token and nothing of the
    // Learning secret, offering Learning's tools and its instructions.
    const [step] = harness.runs;
    expect(step?.token).toBe(DEPLOYMENT_TOKEN);
    expect(step?.path).toBe(provider === "claude" ? "/model" : "/");
    expect(JSON.stringify(step)).not.toContain(LEARNING_SECRET);
    expect(step?.body.forwardedProps).toMatchObject({ openbotModelOnly: true });
    expect(step?.body.tools.map((tool) => tool.name)).toEqual([
      "submit_learning_result",
    ]);
    expect(step?.body.context.map((entry) => entry.value)).toEqual([
      "Find insights in these conversations.",
    ]);
    // Words alone go to the harness as one string, the shape a browser sends every Bot: a text
    // part of their own would end the Claude harness's replay on them (see plan-model.ts).
    expect(step?.body.messages).toEqual([
      expect.objectContaining({
        role: "user",
        content: "Thread 1: the refund took three tries.",
      }),
    ]);

    // The tool's result comes back in the next call, with the call it answers.
    conversation.messages.push(first, {
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "submit_learning_result",
      content: [{ type: "text", text: "Learning result recorded." }],
      isError: false,
      timestamp: Date.now(),
    });
    const second = await ask(conversation);
    expect(second.stopReason).toBe("stop");
    expect(second.content).toContainEqual({ type: "text", text: "Recorded." });
    const replayed = harness.runs[1]?.body.messages ?? [];
    expect(replayed.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "tool",
    ]);
    expect(replayed[2]).toMatchObject({
      toolCallId: "call-1",
      content: "Learning result recorded.",
    });
    // Each call is a conversation of its own on the harness.
    expect(harness.runs[0]?.body.threadId).not.toBe(
      harness.runs[1]?.body.threadId,
    );
  });
}

test("a caller without the Learning secret spends nothing of the plan", async () => {
  const harness = planHarness([
    [
      { type: "TEXT_MESSAGE_START", messageId: "m", role: "assistant" },
      { type: "TEXT_MESSAGE_CONTENT", messageId: "m", delta: "spent" },
      { type: "TEXT_MESSAGE_END", messageId: "m" },
    ],
  ]);
  const base = openBot("chatgpt", harness.url);

  const wrong = (await learningAgent(
    base,
    "a-guess",
    "chatgpt-plan",
  )(context())) as AssistantMessage;
  expect(wrong.stopReason).toBe("error");

  for (const authorization of [null, "Bearer ", `Basic ${LEARNING_SECRET}`]) {
    const response = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(authorization === null ? {} : { authorization }),
      },
      body: JSON.stringify({
        model: "chatgpt-plan",
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    expect(response.status).toBe(401);
  }
  expect(harness.runs).toEqual([]);
});

test("a deployment on an API key, or without Learning's secret, has no Learning endpoint", async () => {
  expect(learningModelEndpointFor(undefined, LEARNING_SECRET)).toBeUndefined();
  expect(
    learningModelEndpointFor(
      {
        provider: "chatgpt",
        endpoint: new URL("http://127.0.0.1:9"),
        token: DEPLOYMENT_TOKEN,
      },
      "  ",
    ),
  ).toBeUndefined();
  const app = new Hono();
  mountLearningModelEndpoint(app, undefined);
  const response = await app.request(LEARNING_MODEL_ROUTE, {
    method: "POST",
    headers: { authorization: `Bearer ${LEARNING_SECRET}` },
    body: "{}",
  });
  expect(response.status).toBe(404);
});

test("a plan that needs signing in again is said as that, not as a broken stream", async () => {
  const harness = planHarness([
    [
      {
        type: "RUN_ERROR",
        message: "refresh token was revoked",
        code: "OPENBOT_MODEL_AUTH_REQUIRED",
      },
    ],
  ]);
  const answer = await learningAgent(
    openBot("chatgpt", harness.url),
    LEARNING_SECRET,
    "chatgpt-plan",
  )(context());
  expect(answer.stopReason).toBe("error");
  expect(answer.errorMessage).toContain(
    "The model plan OpenBot is signed in to needs signing in again.",
  );
});

/**
 * Intelligence keeps a failed run's code and never the Learning agent's error, so Settings says why a
 * run failed from the code and from what reached this endpoint while it ran. The codes are the ones
 * Intelligence's `learning-agent-client.ts` and planner record.
 */
test("a failed run says why, from what reached OpenBot while it ran", async () => {
  const run = {
    status: "failed" as const,
    failureCode: "BatchInsightAgentFailed",
    createdAt: "2026-11-08T10:00:00.000Z",
    startedAt: "2026-11-08T10:00:01.000Z",
    completedAt: "2026-11-08T10:05:00.000Z",
  };
  const during = Date.parse("2026-11-08T10:02:00.000Z");
  const record = (
    ...outcomes: Parameters<LearningModelCalls["record"]>[0][]
  ) => {
    const calls = createLearningModelCalls(() => during);
    for (const outcome of outcomes) calls.record(outcome);
    return calls;
  };

  // What the live check met: the agent's every call failed with "Connection error." and none
  // reached OpenBot.
  expect(runFailure(run, record())).toBe(
    "Learning couldn't reach OpenBot to use your model plan. Quit OpenBot and open it again, then choose Learn now.",
  );
  expect(runFailure(run, record("answered", "sign-in"))).toBe(
    "Your model plan needs signing in again. Sign in to it in OpenBot, then choose Learn now.",
  );
  expect(runFailure(run, record("refused"))).toBe(
    "Learning couldn't sign in to OpenBot. Quit OpenBot and open it again, then choose Learn now.",
  );
  expect(runFailure(run, record("unanswered"))).toBe(
    "Your model plan didn't answer Learning. Try Learn now again in a few minutes.",
  );
  // A call from before the run is not this run's.
  const earlier = createLearningModelCalls(() =>
    Date.parse("2026-11-08T09:00:00.000Z"),
  );
  earlier.record("sign-in");
  expect(runFailure(run, earlier)).toContain("couldn't reach OpenBot");

  // On a key, Learning never calls OpenBot.
  expect(runFailure(run)).toBe(
    "Learning's model didn't finish. Check that your model key works and has credit, then choose Learn now.",
  );
  expect(runFailure({ ...run, failureCode: "QueueDeadLettered" })).toBe(
    "Learning was stopped before it finished. Choose Learn now to try again.",
  );
  expect(
    runFailure({ ...run, status: "succeeded", failureCode: null }),
  ).toBeNull();
});

test("the endpoint records what became of each call", async () => {
  const harness = planHarness([
    [
      { type: "TEXT_MESSAGE_START", messageId: "m", role: "assistant" },
      { type: "TEXT_MESSAGE_CONTENT", messageId: "m", delta: "ok" },
      { type: "TEXT_MESSAGE_END", messageId: "m" },
    ],
    [
      {
        type: "RUN_ERROR",
        message: "refresh token was revoked",
        code: "OPENBOT_MODEL_AUTH_REQUIRED",
      },
    ],
  ]);
  const calls = createLearningModelCalls();
  const base = openBot("chatgpt", harness.url, calls);
  await learningAgent(base, LEARNING_SECRET, "chatgpt-plan")(context());
  await learningAgent(base, LEARNING_SECRET, "chatgpt-plan")(context());
  await learningAgent(base, "a-guess", "chatgpt-plan")(context());
  expect(calls.between(0, Date.now())).toEqual([
    "answered",
    "sign-in",
    "refused",
  ]);
});
