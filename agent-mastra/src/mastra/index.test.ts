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
