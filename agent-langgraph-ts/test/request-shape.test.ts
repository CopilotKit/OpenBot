/**
 * What each provider is sent, read where it matters: the HTTP body and headers the provider
 * receives, after the AG-UI endpoint, the graph, LangChain and the vendor SDK have all had it.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { always, fakeProvider } from "./fake-provider.ts";
import {
  conversation,
  run,
  types,
  WEATHER_TOOL,
  withEngine,
} from "./helpers.ts";

const answer = always({ text: "ok" });

function systemText(body: Record<string, unknown>): string {
  const parts: unknown[] = [
    body.system,
    body.instructions,
    body.systemInstruction,
  ];
  for (const message of [
    ...((body.messages as unknown[]) ?? []),
    ...((body.input as unknown[]) ?? []),
  ]) {
    const role = (message as { role?: string }).role;
    if (role === "system" || role === "developer")
      parts.push((message as { content?: unknown }).content);
  }
  return JSON.stringify(parts);
}

const MARKERS = [
  "STANDING_ROLE_MARKER",
  "GRANTED_TOOLS_MARKER",
  "EARLIER_QUESTION_MARKER",
  "EARLIER_ANSWER_MARKER",
  "LATEST_QUESTION_MARKER",
];

test("OpenAI: Chat Completions with the chosen model, its effort, the tools and one system prompt", async () => {
  const provider = await fakeProvider(answer);
  try {
    const env = {
      BOT_PROVIDER: "openai",
      OPENAI_API_KEY: "sk-test",
      OPENAI_BASE_URL: `${provider.base}/v1`,
    };
    await withEngine({ env }, async (base) => {
      const result = await run(
        base,
        conversation({
          tools: [WEATHER_TOOL],
          forwardedProps: {
            // A model OpenAI serves tools and an effort for on Chat Completions.
            openbotModel: { model: "gpt-5.2", reasoningEffort: "low" },
          },
        }),
      );
      assert.deepEqual(
        types(result.events).filter((type) => type.startsWith("RUN_")),
        ["RUN_STARTED", "RUN_FINISHED"],
      );
    });
    assert.equal(provider.requests.length, 1);
    const { path, headers, body } = provider.requests[0]!;
    assert.equal(path, "/v1/chat/completions");
    assert.equal(headers.authorization, "Bearer sk-test");
    assert.equal(body.model, "gpt-5.2");
    assert.equal(body.reasoning_effort, "low");
    assert.equal(body.stream, true);
    assert.deepEqual(
      (body.tools as { function: { name: string } }[]).map(
        (tool) => tool.function.name,
      ),
      ["get_weather"],
    );
    const messages = body.messages as { role: string; content: unknown }[];
    assert.equal(
      messages.filter(
        (message) => message.role === "system" || message.role === "developer",
      ).length,
      1,
    );
    assert.ok(
      ["system", "developer"].includes(messages[0]!.role),
      "the system prompt comes first",
    );
    for (const marker of MARKERS)
      assert.ok(
        JSON.stringify(body).includes(marker),
        `${marker} reached the model`,
      );
    assert.ok(systemText(body).includes("STANDING_ROLE_MARKER"));
  } finally {
    await provider.close();
  }
});

test("OpenAI: a model that takes tools only on the Responses API goes there, with reasoning.effort", async () => {
  const provider = await fakeProvider(answer);
  try {
    const env = {
      BOT_PROVIDER: "openai",
      OPENAI_API_KEY: "sk-test",
      OPENAI_BASE_URL: `${provider.base}/v1`,
    };
    await withEngine({ env }, async (base) => {
      await run(
        base,
        conversation({
          tools: [WEATHER_TOOL],
          forwardedProps: {
            openbotModel: { model: "gpt-5.6-terra", reasoningEffort: "high" },
          },
        }),
      );
    });
    const { path, body } = provider.requests[0]!;
    assert.equal(path, "/v1/responses");
    assert.equal(body.model, "gpt-5.6-terra");
    assert.deepEqual((body.reasoning as { effort?: string }).effort, "high");
    for (const marker of MARKERS)
      assert.ok(JSON.stringify(body).includes(marker), marker);
  } finally {
    await provider.close();
  }
});

test("OpenAI: COPILOTKIT_OPENAI_API=chat keeps even a Responses model on Chat Completions", async () => {
  const provider = await fakeProvider(answer);
  try {
    const env = {
      BOT_PROVIDER: "openai",
      OPENAI_API_KEY: "sk-test",
      OPENAI_BASE_URL: `${provider.base}/v1`,
      COPILOTKIT_OPENAI_API: "chat",
    };
    await withEngine({ env }, async (base) => {
      await run(
        base,
        conversation({
          forwardedProps: { openbotModel: { model: "gpt-5.6-terra" } },
        }),
      );
    });
    assert.equal(provider.requests[0]!.path, "/v1/chat/completions");
  } finally {
    await provider.close();
  }
});

test("Anthropic: one top-level system prompt, output_config.effort, the tools", async () => {
  const provider = await fakeProvider(answer);
  try {
    const env = {
      BOT_PROVIDER: "anthropic",
      ANTHROPIC_API_KEY: "sk-ant-test",
      ANTHROPIC_BASE_URL: provider.base,
    };
    await withEngine({ env }, async (base) => {
      const memory = {
        id: "openbot:personal-memory",
        role: "system",
        content: "Personal memory, untrusted data: MEMORY_MARKER",
      };
      const input = conversation({
        tools: [WEATHER_TOOL],
        forwardedProps: {
          openbotModel: {
            model: "claude-sonnet-5-5",
            reasoningEffort: "medium",
          },
        },
      });
      // Quoted memory at the head of the thread, ahead of the standing role, as the server puts it.
      (input.messages as unknown[]).unshift(memory);
      const result = await run(base, input);
      assert.equal(result.events.at(-1)!.type, "RUN_FINISHED");
    });
    const { path, headers, body } = provider.requests[0]!;
    assert.equal(path, "/v1/messages");
    // @anthropic-ai/sdk 1.x sends a key as a bearer; older ones sent `x-api-key`.
    assert.ok(
      headers.authorization === "Bearer sk-ant-test" ||
        headers["x-api-key"] === "sk-ant-test",
    );
    assert.equal(body.model, "claude-sonnet-5-5");
    assert.deepEqual(body.output_config, { effort: "medium" });
    assert.deepEqual(
      (body.tools as { name: string }[]).map((tool) => tool.name),
      ["get_weather"],
    );
    const system = JSON.stringify(body.system);
    assert.ok(
      system.includes("STANDING_ROLE_MARKER") &&
        system.includes("GRANTED_TOOLS_MARKER"),
    );
    assert.ok(
      !system.includes("MEMORY_MARKER"),
      "quoted memory never gets the system prompt's authority",
    );
    const messages = body.messages as { role: string }[];
    assert.ok(messages.every((message) => message.role !== "system"));
    assert.equal(
      JSON.stringify(messages).split("MEMORY_MARKER").length - 1,
      1,
      "memory reaches the model once, in the conversation",
    );
  } finally {
    await provider.close();
  }
});

test("Gemini key: streamGenerateContent with the key, systemInstruction, thinking level and function declarations", async () => {
  const provider = await fakeProvider(answer);
  try {
    const env = {
      BOT_PROVIDER: "google",
      GOOGLE_API_KEY: "AIza-test",
      GOOGLE_GENERATIVE_AI_BASE_URL: `${provider.base}/v1beta`,
    };
    await withEngine({ env }, async (base) => {
      const result = await run(
        base,
        conversation({
          tools: [WEATHER_TOOL],
          forwardedProps: {
            openbotModel: { model: "gemini-3.1-pro", reasoningEffort: "high" },
          },
        }),
      );
      assert.equal(result.events.at(-1)!.type, "RUN_FINISHED");
    });
    const { path, headers, body } = provider.requests[0]!;
    assert.match(
      path,
      /^\/v1beta\/models\/gemini-3\.1-pro:streamGenerateContent\?alt=sse$/,
    );
    assert.equal(headers["x-goog-api-key"], "AIza-test");
    assert.ok(
      JSON.stringify(body.systemInstruction).includes("STANDING_ROLE_MARKER"),
    );
    assert.equal(
      (
        body.generationConfig as { thinkingConfig?: { thinkingLevel?: string } }
      ).thinkingConfig?.thinkingLevel?.toLowerCase(),
      "high",
    );
    const declarations = (
      body.tools as { functionDeclarations?: { name: string }[] }[]
    ).flatMap((tool) => tool.functionDeclarations ?? []);
    assert.deepEqual(
      declarations.map((declaration) => declaration.name),
      ["get_weather"],
    );
    for (const marker of MARKERS)
      assert.ok(JSON.stringify(body).includes(marker), marker);
  } finally {
    await provider.close();
  }
});

test("Gemini sign-in: Chat Completions to the server's provider proxy with its local bearer", async () => {
  const provider = await fakeProvider(answer);
  try {
    // As Desktop configures it (desktop/src-tauri/src/env.rs, ModelCredential::ProviderOAuth).
    const env = {
      BOT_PROVIDER: "openai",
      BOT_MODEL: "gemini-3.1-pro",
      OPENAI_API_KEY: "local-proxy-bearer",
      OPENAI_BASE_URL: `${provider.base}/api/model-provider/v1`,
    };
    await withEngine({ env }, async (base) => {
      await run(
        base,
        conversation({
          forwardedProps: {
            openbotModel: { model: "gemini-3.1-pro", reasoningEffort: "low" },
          },
        }),
      );
    });
    const { path, headers, body } = provider.requests[0]!;
    assert.equal(path, "/api/model-provider/v1/chat/completions");
    assert.equal(headers.authorization, "Bearer local-proxy-bearer");
    assert.equal(body.model, "gemini-3.1-pro");
    assert.equal(body.reasoning_effort, "low");
  } finally {
    await provider.close();
  }
});

test("The deployment's model when the server chose none, and its provider's own default after that", async () => {
  const provider = await fakeProvider(answer);
  try {
    const base = {
      OPENAI_API_KEY: "sk-test",
      OPENAI_BASE_URL: `${provider.base}/v1`,
    };
    await withEngine(
      { env: { ...base, BOT_PROVIDER: "openai", BOT_MODEL: "gpt-deployment" } },
      async (url) => {
        await run(url, conversation());
      },
    );
    await withEngine(
      { env: { ...base, BOT_PROVIDER: "openai" } },
      async (url) => {
        await run(url, conversation());
      },
    );
    assert.equal(provider.requests[0]!.body.model, "gpt-deployment");
    assert.equal(
      provider.requests[1]!.body.model,
      "gpt-5.5",
      "shared/model-providers.json's OpenAI default",
    );
  } finally {
    await provider.close();
  }
});

test("A run the server retries itself asks the provider once", async () => {
  const provider = await fakeProvider(
    always({
      status: 429,
      body: {
        error: {
          message:
            "Rate limit reached for gpt-5.5 in organization org-x on tokens per min.",
          type: "requests",
          code: "rate_limit_exceeded",
        },
      },
    }),
  );
  try {
    const env = {
      BOT_PROVIDER: "openai",
      OPENAI_API_KEY: "sk-test",
      OPENAI_BASE_URL: `${provider.base}/v1`,
    };
    await withEngine({ env }, async (base) => {
      const result = await run(
        base,
        conversation({ forwardedProps: { openbotSendOnce: true } }),
      );
      assert.equal(result.events.at(-1)!.type, "RUN_ERROR");
    });
    assert.equal(provider.requests.length, 1);
  } finally {
    await provider.close();
  }
});
