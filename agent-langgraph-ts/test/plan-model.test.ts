/**
 * A ChatGPT plan's model calls, proxied to agent-langgraph-agui.
 *
 * The fake harness answers with streams recorded from the real agent-langgraph-agui image (built
 * from this repository, OpenAI behind it) when sent plan-model.ts's request: RAW, STEP and
 * STATE_SNAPSHOT events included, byte for byte. See test/fixtures/plan-harness/.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { PlanHarnessChatModel } from "../src/plan-model.ts";
import { conversation, run, WEATHER_TOOL, withEngine } from "./helpers.ts";

const fixture = (name: string) =>
  readFileSync(
    new URL(`./fixtures/plan-harness/${name}.sse`, import.meta.url),
    "utf8",
  );

type Harness = {
  url: string;
  requests: {
    path: string;
    headers: IncomingHttpHeaders;
    body: Record<string, unknown>;
  }[];
  close: () => Promise<void>;
};

async function harness(answer: string): Promise<Harness> {
  const requests: Harness["requests"] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    requests.push({
      path: request.url ?? "",
      headers: request.headers,
      body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
    });
    if (request.headers["x-openbot-agent-token"] !== "plan-harness-token") {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "unauthorised" }));
      return;
    }
    // As uvicorn serves ag-ui-langgraph's stream.
    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
    });
    response.end(answer);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const planEnv = (url: string) => ({
  CHATGPT_PLAN_HARNESS_URL: url,
  CHATGPT_PLAN_HARNESS_TOKEN: "plan-harness-token",
  OPENAI_API_KEY: "",
});

test("The plan's model is asked as plan-model.ts asks it, and its words stream on", async () => {
  const fake = await harness(fixture("text"));
  try {
    const result = await withEngine({ env: planEnv(fake.url) }, (base) =>
      run(
        base,
        conversation({
          tools: [WEATHER_TOOL],
          forwardedProps: {
            openbotModel: { model: "gpt-5.5", reasoningEffort: "low" },
          },
        }),
      ),
    );
    assert.equal(fake.requests.length, 1);
    const { path, headers, body } = fake.requests[0]!;
    assert.equal(path, "/");
    assert.equal(headers["x-openbot-agent-token"], "plan-harness-token");
    assert.deepEqual(body.forwardedProps, {
      openbotModelOnly: true,
      openbotBotId: "test-bot",
      openbotModel: { model: "gpt-5.5", reasoningEffort: "low" },
    });
    const context = body.context as { description: string; value: string }[];
    assert.equal(context.length, 1);
    assert.equal(context[0]!.description, "Built-in Bot instructions");
    assert.ok(
      context[0]!.value.includes("STANDING_ROLE_MARKER") &&
        context[0]!.value.includes("GRANTED_TOOLS_MARKER"),
    );
    const messages = body.messages as { role: string; content: string }[];
    assert.deepEqual(
      messages.map((message) => message.role),
      ["user", "assistant", "user"],
    );
    assert.equal(
      typeof messages[0]!.content,
      "string",
      "a words-only message goes as one string",
    );
    assert.deepEqual(
      (body.tools as { name: string }[]).map((tool) => tool.name),
      ["get_weather"],
    );

    const words = result.events
      .filter((event) => event.type === "TEXT_MESSAGE_CONTENT")
      .map((event) => event.delta)
      .join("");
    assert.equal(words, "hello from the plan harness");
    assert.equal(result.events.at(-1)!.type, "RUN_FINISHED");
    assert.ok(
      !result.events.some((event) => event.type === "RAW"),
      "the harness's own events are not this run's",
    );
  } finally {
    await fake.close();
  }
});

test("The plan harness's parallel calls become this run's, under the harness's ids", async () => {
  const fake = await harness(fixture("parallel"));
  try {
    const result = await withEngine({ env: planEnv(fake.url) }, (base) =>
      run(base, conversation({ tools: [WEATHER_TOOL] })),
    );
    const starts = result.events.filter(
      (event) => event.type === "TOOL_CALL_START",
    );
    assert.deepEqual(
      starts.map((event) => event.toolCallId),
      ["call_l5tzE2z7QUpRAjwp5Fw3VLwt", "call_iC7Rh33OXzhWFkHSKMJCC3ZC"],
    );
    const args = (id: string) =>
      result.events
        .filter(
          (event) => event.type === "TOOL_CALL_ARGS" && event.toolCallId === id,
        )
        .map((event) => event.delta)
        .join("");
    assert.deepEqual(JSON.parse(args("call_l5tzE2z7QUpRAjwp5Fw3VLwt")), {
      city: "Paris",
    });
    assert.deepEqual(JSON.parse(args("call_iC7Rh33OXzhWFkHSKMJCC3ZC")), {
      city: "Tokyo",
    });
    assert.equal(
      result.events.filter((event) => event.type === "TOOL_CALL_END").length,
      2,
    );
    assert.equal(
      result.events.at(-1)!.type,
      "RUN_FINISHED",
      "a surface tool ends the run for the surface to answer",
    );
  } finally {
    await fake.close();
  }
});

test("The harness's refusal is relayed as it said it: words and code", async () => {
  const fake = await harness(fixture("refused"));
  try {
    const result = await withEngine({ env: planEnv(fake.url) }, (base) =>
      run(base, conversation({ tools: [WEATHER_TOOL] })),
    );
    const error = result.events.at(-1)!;
    assert.equal(error.type, "RUN_ERROR");
    assert.equal(error.code, "OPENBOT_MODEL_REFUSED");
    assert.match(
      String(error.message),
      /^Error code: 400 - Function tools with reasoning_effort are not supported for gpt-5\.5/,
    );
  } finally {
    await fake.close();
  }
});

test("A sign-in the plan refused is relayed as one", async () => {
  const fake = await harness(fixture("bad-key"));
  try {
    const result = await withEngine({ env: planEnv(fake.url) }, (base) =>
      run(base, conversation()),
    );
    const error = result.events.at(-1)!;
    assert.equal(error.type, "RUN_ERROR");
    assert.equal(error.code, "OPENBOT_MODEL_AUTH_REQUIRED");
    assert.equal(error.message, "Sign in to your model provider again.");
  } finally {
    await fake.close();
  }
});

test("A harness's error category is relayed with its words", async () => {
  // A RUN_ERROR as agent-claude-sdk sends one since #1773: the same AG-UI event with metadata.
  const answer = [
    'data: {"type":"RUN_STARTED","threadId":"t","runId":"r"}\n\n',
    'data: {"type":"RUN_ERROR","message":"Error code: 429 - Rate limit reached","code":"OPENBOT_MODEL_REFUSED","metadata":{"errorCategory":"rate_limit"}}\n\n',
  ].join("");
  const fake = await harness(answer);
  try {
    const result = await withEngine({ env: planEnv(fake.url) }, (base) =>
      run(base, conversation()),
    );
    const error = result.events.at(-1)!;
    assert.deepEqual(
      [
        error.type,
        error.code,
        error.message,
        (error.metadata as { errorCategory?: string })?.errorCategory,
      ],
      [
        "RUN_ERROR",
        "OPENBOT_MODEL_REFUSED",
        "Error code: 429 - Rate limit reached",
        "rate_limit",
      ],
    );
  } finally {
    await fake.close();
  }
});

test("On the last step the plan's model is sent no tools, and told it answers only", async () => {
  const fake = await harness(fixture("text"));
  try {
    const model = new PlanHarnessChatModel({
      url: fake.url,
      token: "plan-harness-token",
    });
    const bound = model.bindTools(
      [
        {
          type: "function",
          function: {
            name: "get_weather",
            description: "d",
            parameters: { type: "object", properties: {} },
          },
        },
      ],
      { tool_choice: "none" },
    );
    const answer = await bound.invoke([{ role: "user", content: "hi" }]);
    assert.equal(answer.text, "hello from the plan harness");
    const { body } = fake.requests[0]!;
    assert.deepEqual(body.tools, []);
    assert.deepEqual(body.forwardedProps, {
      openbotModelOnly: true,
      openbotAnswerOnly: true,
    });
  } finally {
    await fake.close();
  }
});

test("A harness that hangs up mid-answer fails the call rather than ending it as an answer", async () => {
  const fake = await harness(
    fixture("text")
      .split("TEXT_MESSAGE_END")[0]!
      .replace(/data: [^\n]*$/, ""),
  );
  try {
    const result = await withEngine({ env: planEnv(fake.url) }, (base) =>
      run(base, conversation()),
    );
    assert.equal(result.events.at(-1)!.type, "RUN_ERROR");
  } finally {
    await fake.close();
  }
});
