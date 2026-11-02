import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { AbstractAgent, BaseEvent, RunAgentInput } from "@ag-ui/client";
import {
  RUNTIME_STATE_TOOLS,
  TOOL_LIMIT_EXCEEDED,
  toolNamesSent,
} from "@openbot/toolkit/copilotkit/agents";
import type { GrantedTool } from "@openbot/toolkit/granted-tool";
import { lastValueFrom, toArray } from "rxjs";
import { z } from "zod";
import {
  OPENAI_MAX_TOOLS,
  toolLimitFor,
  toolLimitRefusal,
} from "../src/agents/tool-limit";
import {
  buildAgents,
  type RecordToolLimitRefusal,
  type RuntimeModel,
} from "../src/copilot";

/*
 * Issue #883, without the network.
 *
 * A built-in Bot on OpenAI holding 279 tools never answered: OpenAI refuses more than 128 in one
 * request, and nothing said so. The count here is the one the provider would have seen, and every
 * test that expects a refusal also expects that nothing was sent.
 */

const generalAssistant = {
  id: "general-assistant",
  name: "General Assistant",
  type: "built_in" as const,
  systemPrompt: "Be helpful.",
};

const openai: RuntimeModel = {
  provider: "openai",
  defaultModel: "gpt-6.1-terra",
};

function grants(count: number): GrantedTool[] {
  return Array.from({ length: count }, (_, index) => ({
    name: `SHOPIFY_READ_${index}`,
    ref: `composio/shopify/SHOPIFY_READ_${index}`,
    description: "A read-only Shopify action.",
    parameters: z.object({}),
    execute: async () => "ok",
  }));
}

function input(tools: RunAgentInput["tools"] = []): RunAgentInput {
  return {
    threadId: "thread-883",
    runId: "run-883",
    messages: [{ id: "m1", role: "user", content: "How many orders today?" }],
    tools,
    context: [],
    state: {},
    forwardedProps: {},
  };
}

function events(agent: AbstractAgent | undefined, run = input()) {
  if (!agent) throw new Error("buildAgents returned no general-assistant");
  return lastValueFrom(agent.run(run).pipe(toArray()));
}

/** Builds General Assistant with these grants, a recorder, and optionally a handoff tool. */
async function assistant(
  granted: GrantedTool[],
  model: RuntimeModel = openai,
  extra: {
    recorded?: Parameters<RecordToolLimitRefusal>[];
    passing?: GrantedTool[];
  } = {},
) {
  const args: Parameters<typeof buildAgents> = [
    [generalAssistant],
    model,
    "sk-test-not-a-key",
  ];
  args[4] = async () => granted;
  if (extra.passing) {
    const passing = extra.passing;
    args[10] = async () => passing;
  }
  if (extra.recorded) {
    const recorded = extra.recorded;
    args[17] = async (...call) => {
      recorded.push(call);
    };
  }
  return (await buildAgents(...args))["general-assistant"];
}

/** A provider that refuses everything, so a run that reaches it ends without the network. */
function stubProvider() {
  return spyOn(globalThis, "fetch").mockImplementation(
    (async () =>
      new Response(
        JSON.stringify({
          error: {
            message: "stubbed provider",
            type: "invalid_request_error",
          },
        }),
        { status: 400, headers: { "content-type": "application/json" } },
      )) as unknown as typeof fetch,
  );
}

let baseUrl: string | undefined;
let consoleError: ReturnType<typeof spyOn>;
beforeEach(() => {
  baseUrl = process.env.OPENAI_BASE_URL;
  delete process.env.OPENAI_BASE_URL;
  consoleError = spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  if (baseUrl === undefined) delete process.env.OPENAI_BASE_URL;
  else process.env.OPENAI_BASE_URL = baseUrl;
  consoleError.mockRestore();
});

describe("the tools a built-in run sends", () => {
  test("counts the client's tools and the configured ones once each, plus the runtime's own", () => {
    const names = toolNamesSent(
      {
        model: "openai/gpt-6.1-terra",
        tools: grants(2).map(({ name, description, parameters }) => ({
          name,
          description,
          parameters,
        })),
      },
      {
        tools: [
          { name: "SHOPIFY_READ_0", description: "", parameters: {} },
          { name: "render_chart", description: "", parameters: {} },
        ],
      },
    );
    expect(names.sort()).toEqual(
      [
        "SHOPIFY_READ_0",
        "SHOPIFY_READ_1",
        "render_chart",
        ...RUNTIME_STATE_TOOLS,
      ].sort(),
    );
  });
});

describe("which providers are held to a limit", () => {
  test("OpenAI on its own hosts, and unset, is held to 128", () => {
    expect(toolLimitFor("openai", {})).toEqual({
      provider: "OpenAI",
      limit: OPENAI_MAX_TOOLS,
    });
    for (const host of [
      "https://api.openai.com/v1",
      "https://eu.api.openai.com/v1",
      "  ",
    ])
      expect(toolLimitFor("openai", { OPENAI_BASE_URL: host })?.limit).toBe(
        128,
      );
  });

  test("another host behind OPENAI_BASE_URL, and Anthropic, are not limited here", () => {
    expect(
      toolLimitFor("openai", { OPENAI_BASE_URL: "http://localhost:11434/v1" }),
    ).toBeNull();
    expect(
      toolLimitFor("openai", {
        OPENAI_BASE_URL: "https://openrouter.ai/api/v1",
      }),
    ).toBeNull();
    expect(toolLimitFor("anthropic", {})).toBeNull();
  });

  test("the refusal names the Bot, the count, the limit and who can fix it", () => {
    expect(
      toolLimitRefusal("General Assistant", 281, {
        provider: "OpenAI",
        limit: 128,
      }),
    ).toBe(
      "General Assistant was not run: it would be offered 281 tools, and OpenAI accepts at most 128 in one request. An administrator can narrow its grants on the Bot's page.",
    );
  });
});

describe("a built-in Bot over its provider's tool limit", () => {
  test("279 grants on OpenAI end in RUN_ERROR, are recorded, and never reach the provider", async () => {
    const fetch = stubProvider();
    const recorded: Parameters<RecordToolLimitRefusal>[] = [];
    try {
      const seen = await events(
        await assistant(grants(279), openai, { recorded }),
      );
      expect(seen.map((event) => event.type)).toEqual([
        "RUN_STARTED",
        "RUN_ERROR",
      ]);
      const error = seen[1] as BaseEvent & { message: string; code: string };
      expect(error.code).toBe(TOOL_LIMIT_EXCEEDED);
      // 279 grants and the runtime's two state tools: what OpenAI would have been sent.
      expect(error.message).toBe(
        "General Assistant was not run: it would be offered 281 tools, and OpenAI accepts at most 128 in one request. An administrator can narrow its grants on the Bot's page.",
      );
      expect(fetch).not.toHaveBeenCalled();
      expect(recorded).toEqual([
        ["general-assistant", { tools: 281, limit: 128, provider: "OpenAI" }],
      ]);
      expect(consoleError).toHaveBeenCalledWith(
        expect.objectContaining({ error: "tool_limit_exceeded" }),
      );
    } finally {
      fetch.mockRestore();
    }
  });

  test("exactly 128 with the runtime's own goes to the provider", async () => {
    const fetch = stubProvider();
    try {
      const seen = await events(
        await assistant(grants(OPENAI_MAX_TOOLS - RUNTIME_STATE_TOOLS.length)),
      ).catch(() => []);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(
        seen.some(
          (event) => (event as { code?: string }).code === TOOL_LIMIT_EXCEEDED,
        ),
      ).toBe(false);
    } finally {
      fetch.mockRestore();
    }
  });

  test("a client tool that tips the run over is counted", async () => {
    const fetch = stubProvider();
    try {
      const seen = await events(
        await assistant(grants(OPENAI_MAX_TOOLS - RUNTIME_STATE_TOOLS.length)),
        input([{ name: "render_chart", description: "", parameters: {} }]),
      );
      expect((seen[1] as { message?: string }).message).toContain(
        "offered 129 tools",
      );
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      fetch.mockRestore();
    }
  });

  test("a handoff tool added per run is counted on the rebuilt agent too", async () => {
    const fetch = stubProvider();
    try {
      const seen = await events(
        await assistant(
          grants(OPENAI_MAX_TOOLS - RUNTIME_STATE_TOOLS.length),
          openai,
          { passing: grants(1).map((tool) => ({ ...tool, name: "hand_off" })) },
        ),
      );
      expect((seen[1] as { code?: string }).code).toBe(TOOL_LIMIT_EXCEEDED);
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      fetch.mockRestore();
    }
  });

  test("Anthropic is not refused, because no limit is documented for it", async () => {
    const fetch = stubProvider();
    try {
      await events(
        await assistant(grants(279), {
          provider: "anthropic",
          defaultModel: "claude-sonnet-5-5",
        }),
      ).catch(() => []);
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally {
      fetch.mockRestore();
    }
  });
});
