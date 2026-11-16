import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildOpenBotInstructions,
  normalizeChatCompletionChunk,
  openbotBaseInstructions,
} from "./index";

type ModelCase = {
  name: string;
  value?: string;
  expected: string;
};

type PortCase = {
  name: string;
  value?: string;
  expected?: number;
};

function requestContextWith(context: unknown) {
  return {
    get(key: string) {
      if (key !== "ag-ui") return undefined;
      return { context };
    },
  };
}

/**
 * Run a child Bun and read what it printed, through files rather than pipes.
 *
 * On macOS a Bun parent holding more than about 10,240 open descriptors gets nothing back through
 * a spawned child's pipes: the child runs, exits 0, and both pipes read empty. The full test run
 * gets there, because Bun's resolver keeps a directory handle open for every `node_modules`
 * directory it has resolved from, and this file runs late. Files do not have the limit, so every
 * probe here writes stdout and stderr to a scratch directory instead.
 */
async function runProbe(
  command: string[],
  env: Record<string, string>,
  timeoutMs?: number,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const directory = mkdtempSync(join(tmpdir(), "mastra-probe-"));
  const out = join(directory, "stdout");
  const err = join(directory, "stderr");
  try {
    const child = Bun.spawn(command, {
      env,
      stdout: Bun.file(out),
      stderr: Bun.file(err),
    });
    const timer = timeoutMs
      ? setTimeout(() => child.kill(), timeoutMs)
      : undefined;
    const exitCode = await child.exited;
    if (timer) clearTimeout(timer);
    const read = (path: string) => {
      try {
        return readFileSync(path, "utf8");
      } catch {
        return "";
      }
    };
    return { stdout: read(out), stderr: read(err), exitCode };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

async function configuredModelId(botModel: string | undefined) {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "/opt/homebrew/bin:/usr/bin:/bin",
    MASTRA_TELEMETRY_DISABLED: "true",
    DO_NOT_TRACK: "1",
    NODE_ENV: "test",
  };
  if (botModel !== undefined) env.BOT_MODEL = botModel;

  const { stdout, stderr, exitCode } = await runProbe(
    [
      Bun.argv[0],
      "--no-env-file",
      "-e",
      [
        'const { mastra } = await import("./agent-mastra/src/mastra/index.ts");',
        'const model = mastra.getAgent("openbot").model;',
        "console.log(JSON.stringify({ modelId: model.modelId }));",
      ].join("\n"),
    ],
    env,
  );

  if (exitCode !== 0) {
    throw new Error(
      `model probe exited ${exitCode}\nstdout:\n${stdout}\nstderr:\n${stderr}`,
    );
  }

  const modelLine = stdout
    .trim()
    .split("\n")
    .reverse()
    .find((line: string) => line.startsWith("{"));
  if (!modelLine) throw new Error(`model probe produced no JSON:\n${stdout}`);
  return JSON.parse(modelLine).modelId as string;
}

async function configuredPort(port: string | undefined) {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "/opt/homebrew/bin:/usr/bin:/bin",
    MASTRA_TELEMETRY_DISABLED: "true",
    DO_NOT_TRACK: "1",
    NODE_ENV: "test",
  };
  if (port !== undefined) env.PORT = port;

  const { stdout, stderr, exitCode } = await runProbe(
    [
      Bun.argv[0],
      "--no-env-file",
      "-e",
      [
        'const { mastra } = await import("./agent-mastra/src/mastra/index.ts");',
        "console.log(JSON.stringify({ port: mastra.getServer()?.port }));",
      ].join("\n"),
    ],
    env,
  );

  const portLine = stdout
    .trim()
    .split("\n")
    .reverse()
    .find((line: string) => line.startsWith("{"));

  return {
    exitCode,
    stderr,
    stdout,
    port: portLine ? (JSON.parse(portLine).port as number) : undefined,
  };
}

/**
 * How this Bot answers a provider it has no module for: refused at startup, before a model exists.
 *
 * The message is the result rather than an error to be thrown past the assertion, so the exit
 * status is returned the way the port probe returns it.
 */
async function providerStartup(botProvider: string) {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "/opt/homebrew/bin:/usr/bin:/bin",
    MASTRA_TELEMETRY_DISABLED: "true",
    DO_NOT_TRACK: "1",
    NODE_ENV: "test",
    BOT_PROVIDER: botProvider,
  };

  const { stderr, exitCode } = await runProbe(
    [
      Bun.argv[0],
      "-e",
      [
        'const { mastra } = await import("./agent-mastra/src/mastra/index.ts");',
        'const model = mastra.getAgent("openbot").model;',
        "console.log(JSON.stringify({ modelId: model.modelId }));",
      ].join("\n"),
    ],
    env,
  );
  return { exitCode, stderr };
}

describe("OpenBot Mastra receiver instructions", () => {
  test("delivers the learned catalog after the standing role and tool guidance", () => {
    expect(
      buildOpenBotInstructions({
        requestContext: requestContextWith([
          {
            description: "OpenBot learned skills",
            value: "Published skill: refunds",
          },
          {
            description: "OpenBot signed run assertion",
            value: "secret-assertion",
          },
          {
            description: "OpenBot standing role",
            value: "Follow company policy.",
          },
        ]),
      }),
    ).toBe(
      [
        openbotBaseInstructions,
        "Follow company policy.",
        "Published skill: refunds",
      ].join("\n\n"),
    );
  });
  test("adds model-visible OpenBot role context in receiver order", () => {
    const instructions = buildOpenBotInstructions({
      requestContext: requestContextWith([
        {
          description: "OpenBot granted tools guidance",
          value: "Use only the granted Slack tool.",
        },
        {
          description: "OpenBot standing role",
          value: "Use MODEL_BOUNDARY_MANAGED_ROLE in the answer.",
        },
        {
          description: "OpenBot Bot id",
          value: "packaged-mastra-managed",
        },
      ]),
    });

    expect(instructions).toBe(
      [
        openbotBaseInstructions,
        "Use MODEL_BOUNDARY_MANAGED_ROLE in the answer.",
        "Use only the granted Slack tool.",
      ].join("\n\n"),
    );
  });

  test("delivers the caller's context after OpenBot's, and never OpenBot's machine-only entries", () => {
    // The server forwards whatever context the surface sent (`callerMastraContext` in
    // server/src/copilot.ts). Every other harness puts it in front of the model; dropping it here
    // left a Mastra Bot without, say, the component catalogue the surface asked it to draw from.
    const instructions = buildOpenBotInstructions({
      requestContext: requestContextWith([
        {
          description: "Components you can draw",
          value: "CALLER_CATALOG_MARKER",
        },
        {
          description: "OpenBot standing role",
          value: "Follow company policy.",
        },
        {
          description: "OpenBot signed run assertion",
          value: "secret-assertion",
        },
        { description: "OpenBot Bot id", value: "packaged-mastra-managed" },
        { description: "OpenBot deployment tools", value: '["message_bot"]' },
        // Untrusted data: it reaches the model as a quoted conversation row, never as instructions.
        { description: "OpenBot personal memory", value: "QUOTED_MEMORY" },
        { description: "Blank", value: "   " },
      ]),
    });

    expect(instructions).toBe(
      [
        openbotBaseInstructions,
        "Follow company policy.",
        "Components you can draw: CALLER_CATALOG_MARKER",
      ].join("\n\n"),
    );
  });

  test("keeps ordinary Mastra calls on the base receiver instruction", () => {
    expect(buildOpenBotInstructions()).toBe(openbotBaseInstructions);
    expect(
      buildOpenBotInstructions({
        requestContext: requestContextWith("not ag-ui context entries"),
      }),
    ).toBe(openbotBaseInstructions);
  });
});

describe("OpenBot Mastra model configuration", () => {
  const modelCases: ModelCase[] = [
    { name: "absent", expected: "gpt-4o-mini" },
    { name: "empty", value: "", expected: "gpt-4o-mini" },
    { name: "whitespace", value: "  ", expected: "gpt-4o-mini" },
    {
      name: "custom",
      value: " fixture/custom:model ",
      expected: "fixture/custom:model",
    },
  ];

  for (const modelCase of modelCases) {
    test(`uses ${modelCase.expected} when BOT_MODEL is ${modelCase.name}`, async () => {
      expect(await configuredModelId(modelCase.value)).toBe(modelCase.expected);
    });
  }
});

/**
 * A provider this Bot cannot answer for is refused before it can fall into the OpenAI branch and
 * quietly answer with somebody else's model.
 */
describe("OpenBot Mastra provider configuration", () => {
  test("refuses a provider it loads no module for", async () => {
    const { exitCode, stderr } = await providerStartup("google");

    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("loads no Google module");
  });

  test("refuses a provider the registry has not heard of", async () => {
    const { exitCode, stderr } = await providerStartup("mistral");

    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("is not one this Bot knows");
  });
});

describe("OpenBot Mastra listen port configuration", () => {
  const validPortCases: PortCase[] = [
    { name: "absent", expected: 4213 },
    { name: "empty", value: "", expected: 4213 },
    { name: "whitespace", value: "  ", expected: 4213 },
    { name: "default", value: "4213", expected: 4213 },
    { name: "padded integer", value: " 54213 ", expected: 54213 },
    { name: "lower bound", value: "1", expected: 1 },
    { name: "upper bound", value: "65535", expected: 65535 },
  ];

  for (const portCase of validPortCases) {
    test(`uses ${portCase.expected} when PORT is ${portCase.name}`, async () => {
      const result = await configuredPort(portCase.value);

      expect(result.exitCode).toBe(0);
      expect(result.port).toBe(portCase.expected);
    });
  }

  const invalidPortCases: PortCase[] = [
    { name: "zero", value: "0" },
    { name: "negative", value: "-1" },
    { name: "prefix typo", value: "42o0" },
    { name: "decimal", value: "54213.5" },
    { name: "above upper bound", value: "65536" },
    { name: "NaN", value: "NaN" },
    { name: "Infinity", value: "Infinity" },
  ];

  for (const portCase of invalidPortCases) {
    test(`rejects PORT ${portCase.name} before configuring the listener`, async () => {
      const result = await configuredPort(portCase.value);

      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain(
        `PORT must be a whole number from 1 to 65535 (got ${JSON.stringify(
          portCase.value,
        )}).`,
      );
      expect(result.stdout).not.toContain('"port"');
    });
  }
});

describe("OpenBot Mastra provider requests", () => {
  const choices: {
    provider: string;
    base: string;
    model: string;
    url: string;
    apiKey?: string;
    error?: string;
  }[] = [
    {
      provider: "anthropic",
      base: "",
      model: "claude-sonnet-4-5",
      url: "https://api.anthropic.com/v1/messages",
      apiKey: "test-anthropic",
    },
    {
      provider: "anthropic",
      base: "http://anthropic.test/v1",
      model: "claude-sonnet-4-5",
      url: "http://anthropic.test/v1/messages",
      apiKey: "test-anthropic",
    },
    {
      provider: "",
      base: "",
      model: "gpt-5.5",
      url: "https://api.openai.com/v1/responses",
      apiKey: "test-openai",
    },
    {
      provider: "openai",
      base: " https://api.openai.com/v1/ ",
      model: "gpt-5.5",
      url: "https://api.openai.com/v1/responses",
      apiKey: "test-openai",
    },
    {
      provider: "",
      base: "http://compatible.test/v1",
      model: "llama3.1:8b",
      url: "http://compatible.test/v1/chat/completions",
      apiKey: "test-openai",
    },
    ...[
      "http://anthropic.test",
      " http://anthropic.test/proxy/ ",
      "http://anthropic.test/proxy/v1/",
    ].map((base) => ({
      provider: "anthropic",
      base,
      model: "claude-sonnet-4-5",
      apiKey: "test-anthropic",
      url: base.includes("proxy")
        ? "http://anthropic.test/proxy/v1/messages"
        : "http://anthropic.test/v1/messages",
    })),
    ...[undefined, ""].map((apiKey) => ({
      provider: "openai",
      base: "http://compatible.test/v1",
      model: "llama3.1:8b",
      apiKey,
      url: "http://compatible.test/v1/chat/completions",
    })),
    {
      provider: "openai",
      base: "",
      model: "gpt-5.5",
      url: "https://api.openai.com/v1/responses",
      error: "OpenAI API key is missing",
    },
  ];

  for (const choice of choices) {
    test(`uses ${choice.base || "the default endpoint"} with ${choice.apiKey === undefined ? "no" : choice.apiKey || "an empty"} API key`, async () => {
      const seen: { url: string | null; key: string | null; model: string }[] =
        [];
      const provider = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(request) {
          const body = await request.json();
          seen.push({
            url: request.headers.get("x-test-original-url"),
            key: request.headers.get(
              choice.provider === "anthropic" ? "x-api-key" : "authorization",
            ),
            model: body.model,
          });
          const path = new URL(request.url).pathname;
          if (path.endsWith("/v1/messages")) {
            return Response.json({
              id: "msg",
              type: "message",
              role: "assistant",
              model: body.model,
              content: [{ type: "text", text: "hello" }],
              stop_reason: "end_turn",
              stop_sequence: null,
              usage: { input_tokens: 1, output_tokens: 1 },
            });
          }
          if (path === "/v1/chat/completions") {
            return Response.json({
              id: "chat",
              object: "chat.completion",
              created: 0,
              model: body.model,
              choices: [
                {
                  index: 0,
                  finish_reason: "stop",
                  message: { role: "assistant", content: "hello" },
                },
              ],
              usage: {
                prompt_tokens: 1,
                completion_tokens: 1,
                total_tokens: 2,
              },
            });
          }
          if (path === "/v1/responses") {
            return Response.json({
              id: "resp",
              object: "response",
              created_at: 0,
              model: body.model,
              status: "completed",
              output: [
                {
                  id: "msg",
                  type: "message",
                  role: "assistant",
                  status: "completed",
                  content: [
                    { type: "output_text", text: "hello", annotations: [] },
                  ],
                },
              ],
              usage: {
                input_tokens: 1,
                output_tokens: 1,
                input_tokens_details: { cached_tokens: 0 },
                output_tokens_details: { reasoning_tokens: 0 },
              },
            });
          }
          return new Response("unexpected provider route", { status: 404 });
        },
      });
      try {
        const { stdout, stderr, exitCode } = await runProbe(
          [
            Bun.argv[0],
            "--no-env-file",
            "-e",
            [
              // Only HTTP is replaced: the real Mastra Agent and provider SDK build the request.
              "const networkFetch = globalThis.fetch;",
              "globalThis.fetch = (input, init) => {",
              "  const request = new Request(input, init);",
              "  const url = new URL(request.url);",
              '  request.headers.set("x-test-original-url", request.url);',
              `  return networkFetch(new Request(${JSON.stringify(provider.url.toString())} + url.pathname.slice(1) + url.search, request));`,
              "};",
              'const { mastra } = await import("./agent-mastra/src/mastra/index.ts");',
              'const result = await mastra.getAgent("openbot").generate("Say hello");',
              "console.log(JSON.stringify({ text: result.text }));",
            ].join("\n"),
          ],
          {
            PATH: process.env.PATH ?? "/opt/homebrew/bin:/usr/bin:/bin",
            MASTRA_TELEMETRY_DISABLED: "true",
            DO_NOT_TRACK: "1",
            NODE_ENV: "test",
            BOT_PROVIDER: choice.provider,
            BOT_MODEL: choice.model,
            ANTHROPIC_API_KEY:
              choice.provider === "anthropic" ? choice.apiKey : "",
            OPENAI_API_KEY:
              choice.provider === "anthropic" ? "" : choice.apiKey,
            ANTHROPIC_BASE_URL:
              choice.provider === "anthropic" ? choice.base : "",
            OPENAI_BASE_URL: choice.provider === "anthropic" ? "" : choice.base,
          },
          10_000,
        );
        if (choice.error) {
          expect(exitCode).not.toBe(0);
          expect(stderr).toContain(choice.error);
          expect(seen).toEqual([]);
          return;
        }
        if (exitCode !== 0)
          throw new Error(
            `provider probe exited ${exitCode}\n${stdout}\n${stderr}`,
          );
        expect(stdout).toContain('"text":"hello"');
        expect(seen).toEqual([
          {
            url: choice.url,
            key:
              choice.provider === "anthropic"
                ? (choice.apiKey ?? null)
                : `Bearer ${choice.apiKey?.trim() || "no-key-needed"}`,
            model: choice.model,
          },
        ]);
      } finally {
        await provider.stop(true);
      }
    }, 15_000);
  }
});

describe("OpenBot Mastra compatible-endpoint tool-call chunks", () => {
  test("defaults a missing tool-call index to its position in the array", () => {
    const chunk = {
      id: "chatcmpl-gemini",
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                id: "call_one",
                function: { name: "host_list_folders", arguments: "{}" },
              },
              {
                id: "call_two",
                index: 4,
                function: { name: "host_list_folders", arguments: "{}" },
              },
              {
                id: "call_three",
                function: { name: "host_list_folders", arguments: "{}" },
              },
            ],
            extra_content: { google: { thought_signature: "thought" } },
          },
        },
      ],
    };
    const normalized = normalizeChatCompletionChunk(chunk) as typeof chunk;
    expect(normalized.choices[0].delta.tool_calls[0]).toMatchObject({
      id: "call_one",
      index: 0,
    });
    // An index the endpoint did send is kept, even when it is not the position.
    expect(normalized.choices[0].delta.tool_calls[1]).toMatchObject({
      id: "call_two",
      index: 4,
    });
    expect(normalized.choices[0].delta.tool_calls[2]).toMatchObject({
      id: "call_three",
      index: 2,
    });
    // Everything else on the chunk survives, including what the schema ignores.
    expect(normalized.choices[0].delta.extra_content).toEqual({
      google: { thought_signature: "thought" },
    });
  });

  test("leaves a chunk with no missing index untouched", () => {
    const chunk = {
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              { index: 0, function: { name: "a", arguments: "{}" } },
            ],
          },
        },
      ],
    };
    expect(normalizeChatCompletionChunk(chunk)).toBe(chunk);
  });

  test("leaves values that are not chat chunks untouched", () => {
    expect(normalizeChatCompletionChunk(null)).toBe(null);
    expect(normalizeChatCompletionChunk("data: [DONE]")).toBe("data: [DONE]");
    const usage = { choices: [], usage: { total_tokens: 3 } };
    expect(normalizeChatCompletionChunk(usage)).toBe(usage);
  });

  test("streams a tool call whose delta omits the tool-call index", async () => {
    // Gemini's OpenAI-compatible endpoint streams tool-call deltas without `index`, and the
    // AI SDK's chat-chunk schema requires it, so the run failed with "Type validation failed"
    // (#1716). The chunks below are that shape: no index on the tool call, plus the
    // extra_content Gemini adds beside it.
    const chunks = [
      {
        id: "chatcmpl-gemini",
        object: "chat.completion.chunk",
        created: 0,
        model: "gemini-2.0-flash",
        choices: [
          {
            index: 0,
            delta: {
              role: "assistant",
              tool_calls: [
                {
                  id: "call_host_list_folders",
                  type: "function",
                  function: { name: "host_list_folders", arguments: "{}" },
                },
              ],
              extra_content: { google: { thought_signature: "thought" } },
            },
            finish_reason: null,
          },
        ],
      },
      {
        id: "chatcmpl-gemini",
        object: "chat.completion.chunk",
        created: 0,
        model: "gemini-2.0-flash",
        choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
      },
    ];
    const sse = `${chunks
      .map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`)
      .join("")}data: [DONE]\n\n`;
    const provider = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const path = new URL(request.url).pathname;
        if (path !== "/v1/chat/completions") {
          return new Response("unexpected provider route", { status: 404 });
        }
        // Dribble the stream out a few bytes at a time, the way a live endpoint does: a
        // normaliser that only copes with whole lines would miss a chunk split mid-line.
        const bytes = new TextEncoder().encode(sse);
        let offset = 0;
        const body = new ReadableStream({
          pull(controller) {
            if (offset >= bytes.length) {
              controller.close();
              return;
            }
            const end = Math.min(offset + 11, bytes.length);
            controller.enqueue(bytes.slice(offset, end));
            offset = end;
          },
        });
        return new Response(body, {
          headers: { "content-type": "text/event-stream" },
        });
      },
    });
    try {
      const { stdout, stderr, exitCode } = await runProbe(
        [
          Bun.argv[0],
          "--no-env-file",
          "-e",
          [
            // Only HTTP is replaced: the real Mastra Agent and provider SDK build the request.
            "const networkFetch = globalThis.fetch;",
            "globalThis.fetch = (input, init) => {",
            "  const request = new Request(input, init);",
            "  const url = new URL(request.url);",
            `  return networkFetch(new Request(${JSON.stringify(provider.url.toString())} + url.pathname.slice(1) + url.search, request));`,
            "};",
            'const { mastra } = await import("./agent-mastra/src/mastra/index.ts");',
            'const model = mastra.getAgent("openbot").model;',
            "const { stream } = await model.doStream({",
            '  prompt: [{ role: "user", content: [{ type: "text", text: "List the folders" }] }],',
            '  tools: [{ type: "function", name: "host_list_folders", description: "List the folders", inputSchema: { type: "object", properties: {} } }],',
            "});",
            "const parts = [];",
            "for await (const part of stream) parts.push(part);",
            "console.log(JSON.stringify({ parts }));",
          ].join("\n"),
        ],
        {
          PATH: process.env.PATH ?? "/opt/homebrew/bin:/usr/bin:/bin",
          MASTRA_TELEMETRY_DISABLED: "true",
          DO_NOT_TRACK: "1",
          NODE_ENV: "test",
          BOT_PROVIDER: "openai",
          BOT_MODEL: "gemini-2.0-flash",
          OPENAI_BASE_URL: "http://compatible.test/v1",
          OPENAI_API_KEY: "test-key",
        },
        10_000,
      );
      if (exitCode !== 0)
        throw new Error(
          `provider probe exited ${exitCode}\n${stdout}\n${stderr}`,
        );
      const line = stdout
        .trim()
        .split("\n")
        .reverse()
        .find((line: string) => line.startsWith("{"));
      if (!line) throw new Error(`provider probe produced no JSON:\n${stdout}`);
      const parts = (JSON.parse(line).parts ?? []) as Record<string, unknown>[];
      expect(parts).toContainEqual(
        expect.objectContaining({
          type: "tool-call",
          toolName: "host_list_folders",
          input: "{}",
        }),
      );
    } finally {
      await provider.stop(true);
    }
  }, 15_000);
});
