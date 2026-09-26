import { describe, expect, test } from "bun:test";
import { buildOpenBotInstructions, openbotBaseInstructions } from "./index";

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

async function configuredModelId(botModel: string | undefined) {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "/opt/homebrew/bin:/usr/bin:/bin",
    MASTRA_TELEMETRY_DISABLED: "true",
    DO_NOT_TRACK: "1",
    NODE_ENV: "test",
  };
  if (botModel !== undefined) env.BOT_MODEL = botModel;

  const child = Bun.spawn(
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
    { env, stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);

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

  const child = Bun.spawn(
    [
      Bun.argv[0],
      "--no-env-file",
      "-e",
      [
        'const { mastra } = await import("./agent-mastra/src/mastra/index.ts");',
        "console.log(JSON.stringify({ port: mastra.getServer()?.port }));",
      ].join("\n"),
    ],
    { env, stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);

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
      const child = Bun.spawn(
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
          env: {
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
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const timeout = setTimeout(() => child.kill(), 10_000);
      try {
        const [stdout, stderr, exitCode] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]);
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
        clearTimeout(timeout);
        child.kill();
        await provider.stop(true);
      }
    }, 15_000);
  }
});
