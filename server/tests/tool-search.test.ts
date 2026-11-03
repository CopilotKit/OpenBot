import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  type AbstractAgent,
  type BaseEvent,
  EventType,
  type Message,
  type RunAgentInput,
} from "@ag-ui/client";
import { MODEL_TOOL_LIMIT } from "@openbot/shared/model-tool-limit";
import {
  RUNTIME_STATE_TOOLS,
  TOOL_LIMIT_EXCEEDED,
  toolNamesSent,
} from "@openbot/toolkit/copilotkit/agents";
import type { GrantedTool } from "@openbot/toolkit/granted-tool";
import { lastValueFrom, toArray } from "rxjs";
import { z } from "zod";
import { toolLimitFor, toolLimitRefusal } from "../src/agents/tool-limit";
import {
  loadedBySearch,
  planToolSearch,
  rankTools,
  SEARCH_TOOLS,
  searchToolsTool,
  TOOL_SEARCH_FLOOR,
  toolsForStep,
} from "../src/agents/tool-search";
import {
  buildAgents,
  type RecordToolLimitRefusal,
  type RuntimeModel,
} from "../src/copilot";
import { grantedToolGuidance, grantedTools } from "../src/plugins/tools";

/*
 * General Assistant after its Shopify approval, without the network.
 *
 * 279 granted tools: 278 Shopify reads and the one a question about orders needs. Each provider's
 * turn is scripted at `fetch`: the model searches, calls what it found, and answers. Every request is
 * read back to check what the model was actually sent, and every call is checked to have gone
 * through the plugin store's `callTool`, which is where the grant, the policy and the audit row are.
 */

const ORDERS = "SHOPIFY_LIST_ORDERS";

const generalAssistant = {
  id: "general-assistant",
  name: "General Assistant",
  type: "built_in" as const,
  systemPrompt: "Be helpful.",
};

/** The Shopify catalogue as the plugin store lists it for a Bot: 278 reads and the orders list. */
function catalogue() {
  return [
    ...Array.from({ length: 278 }, (_, index) => ({
      toolName: `SHOPIFY_GET_RESOURCE_${index}`,
      ref: `shopify/SHOPIFY_GET_RESOURCE_${index}`,
      description: `Retrieves Shopify Admin API resource number ${index}.`,
      inputSchema: {
        type: "object",
        properties: { id: { type: "string" } },
      },
    })),
    {
      toolName: ORDERS,
      ref: `shopify/${ORDERS}`,
      description: "Lists the orders placed in the store, newest first.",
      inputSchema: {
        type: "object",
        properties: { status: { type: "string" } },
      },
    },
  ];
}

/** A plugin store holding that catalogue for the Bot, recording every call that reaches it. */
function pluginStore(calls: { ref: string; botId: string }[]) {
  return {
    listForAgent: async () => ({ tools: catalogue() }),
    callTool: async (call: { ref: string; botId: string }) => {
      calls.push({ ref: call.ref, botId: call.botId });
      return { text: '{"orders":[{"id":1}]}', isError: false };
    },
  } as never;
}

/** A tool every Bot holds whatever it was granted, standing in for memory and its kin. */
const remember: GrantedTool = {
  name: "remember",
  ref: "openbot/remember",
  description: "Save something to remember about the person.",
  parameters: z.object({ fact: z.string() }),
  execute: async () => "saved",
};

async function heldTools(calls: { ref: string; botId: string }[]) {
  return [
    remember,
    ...(await grantedTools({
      store: pluginStore(calls),
      botId: generalAssistant.id,
      actorId: "person-1",
    })),
  ];
}

function input(messages: Message[], tools: RunAgentInput["tools"] = []) {
  return {
    threadId: "thread-tool-search",
    runId: crypto.randomUUID(),
    messages,
    tools,
    context: [],
    state: {},
    forwardedProps: {},
  } satisfies RunAgentInput;
}

const asked: Message = {
  id: "u1",
  role: "user",
  content: "How many orders came in today?",
};

function events(agent: AbstractAgent | undefined, run: RunAgentInput) {
  if (!agent) throw new Error("buildAgents returned no general-assistant");
  return lastValueFrom(agent.run(run).pipe(toArray()));
}

async function assistant(
  granted: GrantedTool[],
  model: RuntimeModel,
  recorded?: Parameters<RecordToolLimitRefusal>[],
) {
  const args: Parameters<typeof buildAgents> = [
    [generalAssistant],
    model,
    "sk-test-not-a-key",
  ];
  args[4] = async () => granted;
  if (recorded)
    args[17] = async (...call) => {
      recorded.push(call);
    };
  return (await buildAgents(...args))["general-assistant"];
}

/** What the scripted model does on one step. */
type Step = { call: string; args: Record<string, unknown> } | { text: string };

type Wire = "responses" | "chat" | "anthropic";

const sse = (chunks: unknown[], named = false) =>
  `${chunks
    .map(
      (chunk) =>
        `${named ? `event: ${(chunk as { type: string }).type}\n` : ""}data: ${JSON.stringify(chunk)}\n\n`,
    )
    .join("")}${named ? "" : "data: [DONE]\n\n"}`;

/** One step's answer, as each provider streams it. */
function streamed(wire: Wire, step: Step, index: number): string {
  const id = `call_${index}`;
  if (wire === "chat") {
    const chunk = (delta: unknown, finish: string | null) => ({
      id: `chatcmpl-${index}`,
      object: "chat.completion.chunk",
      created: 0,
      model: "gpt-5.5",
      choices: [{ index: 0, delta, finish_reason: finish }],
    });
    return sse(
      "call" in step
        ? [
            chunk(
              {
                role: "assistant",
                tool_calls: [
                  {
                    index: 0,
                    id,
                    type: "function",
                    function: {
                      name: step.call,
                      arguments: JSON.stringify(step.args),
                    },
                  },
                ],
              },
              null,
            ),
            chunk({}, "tool_calls"),
          ]
        : [
            chunk({ role: "assistant", content: step.text }, null),
            chunk({}, "stop"),
          ],
    );
  }
  if (wire === "anthropic") {
    const block =
      "call" in step
        ? [
            {
              type: "content_block_start",
              index: 0,
              content_block: {
                type: "tool_use",
                id: `toolu_${index}`,
                name: step.call,
                input: {},
              },
            },
            {
              type: "content_block_delta",
              index: 0,
              delta: {
                type: "input_json_delta",
                partial_json: JSON.stringify(step.args),
              },
            },
          ]
        : [
            {
              type: "content_block_start",
              index: 0,
              content_block: { type: "text", text: "" },
            },
            {
              type: "content_block_delta",
              index: 0,
              delta: { type: "text_delta", text: step.text },
            },
          ];
    return sse(
      [
        {
          type: "message_start",
          message: {
            id: `msg_${index}`,
            type: "message",
            role: "assistant",
            model: "claude-sonnet-5-5",
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 0 },
          },
        },
        ...block,
        { type: "content_block_stop", index: 0 },
        {
          type: "message_delta",
          delta: {
            stop_reason: "call" in step ? "tool_use" : "end_turn",
            stop_sequence: null,
          },
          usage: { output_tokens: 1 },
        },
        { type: "message_stop" },
      ],
      true,
    );
  }
  const item =
    "call" in step
      ? {
          type: "function_call",
          id: `fc_${index}`,
          call_id: id,
          name: step.call,
          arguments: JSON.stringify(step.args),
          status: "completed",
        }
      : {
          type: "message",
          id: `msg_${index}`,
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: step.text, annotations: [] }],
        };
  return sse([
    {
      type: "response.created",
      response: { id: `resp_${index}`, created_at: 0, model: "gpt-6.1-terra" },
    },
    {
      type: "response.output_item.added",
      output_index: 0,
      item:
        "call" in step
          ? { ...item, arguments: "", status: "in_progress" }
          : { ...item, content: [], status: "in_progress" },
    },
    ...("call" in step
      ? []
      : [
          {
            type: "response.output_text.delta",
            item_id: `msg_${index}`,
            output_index: 0,
            content_index: 0,
            delta: step.text,
          },
        ]),
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: "response.completed",
      response: {
        id: `resp_${index}`,
        status: "completed",
        incomplete_details: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    },
  ]);
}

/** The tool names one request carried, read from its body the way each provider reads it. */
function namesIn(wire: Wire, body: { tools?: unknown[] }): string[] {
  return (body.tools ?? []).map((tool) =>
    wire === "chat"
      ? (tool as { function: { name: string } }).function.name
      : (tool as { name: string }).name,
  );
}

/** A provider that answers each request with the next scripted step, recording what was sent. */
function scriptedProvider(wire: Wire, steps: Step[]) {
  const sent: string[][] = [];
  const spy = spyOn(globalThis, "fetch").mockImplementation((async (
    _url: unknown,
    init?: RequestInit,
  ) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    const index = sent.length;
    sent.push(namesIn(wire, body));
    const step = steps[index] ?? { text: "Done." };
    return new Response(streamed(wire, step, index), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  }) as unknown as typeof fetch);
  return { sent, restore: () => spy.mockRestore() };
}

const PROVIDERS: {
  name: string;
  wire: Wire;
  model: RuntimeModel;
  baseUrl?: string;
}[] = [
  {
    name: "OpenAI on the Responses API",
    wire: "responses",
    model: { provider: "openai", defaultModel: "gpt-6.1-terra" },
  },
  {
    name: "an OpenAI-compatible gateway on Chat Completions",
    wire: "chat",
    model: { provider: "openai", defaultModel: "gpt-5.5" },
    baseUrl: "https://gateway.example.com/v1",
  },
  {
    name: "Anthropic",
    wire: "anthropic",
    model: { provider: "anthropic", defaultModel: "claude-sonnet-5-5" },
  },
];

const saved: Record<string, string | undefined> = {};
let consoleError: ReturnType<typeof spyOn>;
let consoleInfo: ReturnType<typeof spyOn>;
beforeEach(() => {
  for (const key of [
    "OPENAI_BASE_URL",
    "ANTHROPIC_BASE_URL",
    "COPILOTKIT_OPENAI_API",
  ]) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  consoleError = spyOn(console, "error").mockImplementation(() => {});
  consoleInfo = spyOn(console, "info").mockImplementation(() => {});
});
afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  consoleError.mockRestore();
  consoleInfo.mockRestore();
});

function textOf(seen: BaseEvent[]): string {
  return seen
    .filter((event) => event.type === EventType.TEXT_MESSAGE_CONTENT)
    .map((event) => (event as { delta?: string }).delta ?? "")
    .join("");
}

describe.each(PROVIDERS)("a Bot holding 279 tools, on $name", (provider) => {
  test("is sent its own tools and search, finds the orders tool, and calls it through the plugin store", async () => {
    if (provider.baseUrl) process.env.OPENAI_BASE_URL = provider.baseUrl;
    const calls: { ref: string; botId: string }[] = [];
    const script = scriptedProvider(provider.wire, [
      { call: SEARCH_TOOLS, args: { query: "list orders" } },
      { call: ORDERS, args: {} },
      { text: "One order came in today." },
    ]);
    try {
      const seen = await events(
        await assistant(await heldTools(calls), provider.model),
        input([asked]),
      );

      expect(seen.map((event) => event.type)).not.toContain(
        EventType.RUN_ERROR,
      );
      expect(textOf(seen)).toBe("One order came in today.");
      expect(script.sent).toHaveLength(3);
      for (const names of script.sent) {
        expect(names.length).toBeLessThanOrEqual(MODEL_TOOL_LIMIT);
        expect(names).toContain(SEARCH_TOOLS);
        expect(names).toContain("remember");
      }
      // Nothing from the app on the first step, and the found tool from the step after the search.
      expect(script.sent[0]).not.toContain(ORDERS);
      expect(script.sent[0]?.some((name) => name.startsWith("SHOPIFY_"))).toBe(
        false,
      );
      expect(script.sent[1]).toContain(ORDERS);
      expect(calls).toEqual([
        { ref: `shopify/${ORDERS}`, botId: generalAssistant.id },
      ]);
    } finally {
      script.restore();
    }
  });

  test("still sends a tool found in an earlier turn, from the replayed history", async () => {
    if (provider.baseUrl) process.env.OPENAI_BASE_URL = provider.baseUrl;
    const calls: { ref: string; botId: string }[] = [];
    const script = scriptedProvider(provider.wire, [
      { text: "Still one order." },
    ]);
    const history: Message[] = [
      asked,
      {
        id: "a1",
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "call_search",
            type: "function",
            function: {
              name: SEARCH_TOOLS,
              arguments: '{"query":"list orders"}',
            },
          },
        ],
      },
      {
        id: "t1",
        role: "tool",
        toolCallId: "call_search",
        // As the runtime stores a tool's string result: JSON-encoded once more.
        content: JSON.stringify(
          `Found 1 tools for "list orders". Call them from your next step:\n- ${ORDERS}: Lists the orders placed in the store, newest first.`,
        ),
      },
      { id: "a2", role: "assistant", content: "One order came in today." },
      { id: "u2", role: "user", content: "And now?" },
    ];
    try {
      const seen = await events(
        await assistant(await heldTools(calls), provider.model),
        input(history),
      );
      expect(seen.map((event) => event.type)).not.toContain(
        EventType.RUN_ERROR,
      );
      expect(script.sent[0]).toContain(ORDERS);
      expect(script.sent[0]?.length).toBeLessThanOrEqual(MODEL_TOOL_LIMIT);
    } finally {
      script.restore();
    }
  });

  test("cannot call a tool it was not granted: nothing reaches the plugin store", async () => {
    if (provider.baseUrl) process.env.OPENAI_BASE_URL = provider.baseUrl;
    const calls: { ref: string; botId: string }[] = [];
    const script = scriptedProvider(provider.wire, [
      { call: "SHOPIFY_DELETE_STORE", args: {} },
      { text: "I can't do that." },
    ]);
    try {
      const seen = await events(
        await assistant(await heldTools(calls), provider.model),
        input([asked]),
      ).catch(() => [] as BaseEvent[]);
      expect(calls).toEqual([]);
      const result = seen.find(
        (event) => event.type === EventType.TOOL_CALL_RESULT,
      ) as { content?: string } | undefined;
      expect(result?.content).toStartWith(
        "Error: Model tried to call unavailable tool 'SHOPIFY_DELETE_STORE'.",
      );
    } finally {
      script.restore();
    }
  });
});

describe("search_tools", () => {
  const granted = () =>
    catalogue().map((tool) => ({
      name: tool.toolName,
      ref: tool.ref,
      searchable: true as const,
      description: tool.description,
      parameters: z.object({}),
      execute: async () => "ok",
    }));

  test("ranks the tool whose name says what was asked first", () => {
    expect(rankTools("list orders", granted())[0]?.name).toBe(ORDERS);
    expect(rankTools("orders", granted())[0]?.name).toBe(ORDERS);
  });

  test("returns only tools from the set it was given, and says so when nothing matches", async () => {
    const search = searchToolsTool(granted());
    const found = await search.execute({ query: "list orders" });
    expect(found).toContain(`- ${ORDERS}:`);
    const none = await search.execute({ query: "send an email" });
    expect(none).toContain('No tool matched "send an email".');
    expect(none).toContain("Tools you can search:");
    expect(none).not.toContain("- SHOPIFY");
  });
});

describe("which tools wait behind search", () => {
  const tools = (count: number, searchable: boolean): GrantedTool[] =>
    Array.from({ length: count }, (_, index) => ({
      name: `${searchable ? "APP" : "OWN"}_${index}`,
      ref: `${searchable ? "app" : "openbot"}/${index}`,
      description: "",
      parameters: z.object({}),
      execute: async () => "ok",
      ...(searchable ? { searchable: true as const } : {}),
    }));

  test("nothing waits at or under the floor, so today's Bots are sent what they always were", () => {
    expect(planToolSearch(tools(TOOL_SEARCH_FLOOR, true)).size).toBe(0);
  });

  test("an app's tools wait past the floor, and a Bot's own tools never do", () => {
    const own = tools(10, false);
    const waiting = planToolSearch([...own, ...tools(279, true)]);
    expect(waiting.size).toBe(279);
    for (const tool of own) expect(waiting.has(tool.name)).toBe(false);
  });

  test("the tools a chosen skill asked for stay in front of the model", () => {
    const waiting = planToolSearch(tools(279, true), {
      pinned: new Set(["APP_3", "APP_4"]),
    });
    expect(waiting.has("APP_3")).toBe(false);
    expect(waiting.size).toBe(277);
  });

  test("a web search tool stays, because the computer's instructions send searching to it", () => {
    const search: GrantedTool = {
      name: "web_search_exa",
      ref: "exa/web_search_exa",
      searchable: true,
      description: "",
      parameters: z.object({}),
      execute: async () => "ok",
    };
    expect(planToolSearch([search, ...tools(279, true)]).has(search.name)).toBe(
      false,
    );
  });
});

describe("what one step is sent", () => {
  const fn = (name: string) => ({
    type: "function" as const,
    name,
    inputSchema: { type: "object" as const },
  });

  test("found tools fill only the room under the limit, newest first", () => {
    const waiting = new Set(
      Array.from({ length: 200 }, (_, index) => `APP_${index}`),
    );
    const own = Array.from({ length: 100 }, (_, index) => fn(`OWN_${index}`));
    const all = [...own, ...[...waiting].map(fn)];
    const prompt = [
      {
        role: "tool" as const,
        content: [
          {
            type: "tool-result" as const,
            toolCallId: "1",
            toolName: SEARCH_TOOLS,
            output: {
              type: "text" as const,
              value: [...waiting].map((name) => `- ${name}: x`).join("\n"),
            },
          },
        ],
      },
    ];
    const sent = toolsForStep(all, prompt, waiting) ?? [];
    expect(sent).toHaveLength(MODEL_TOOL_LIMIT);
    expect(sent.slice(0, 100).map((tool) => tool.name)).toEqual(
      own.map((tool) => tool.name),
    );
  });

  test("reads a found tool from a result replayed as JSON-encoded text", () => {
    const prompt = [
      {
        role: "tool" as const,
        content: [
          {
            type: "tool-result" as const,
            toolCallId: "1",
            toolName: SEARCH_TOOLS,
            output: {
              type: "text" as const,
              value: JSON.stringify(`Found 1 tools:\n- ${ORDERS}: Lists.`),
            },
          },
        ],
      },
    ];
    expect(loadedBySearch(prompt, new Set([ORDERS, "SHOPIFY_LIST"]))).toEqual([
      ORDERS,
    ]);
  });
});

describe("what the Bot is told it holds", () => {
  test("names the tools it can see and counts the ones it finds with search", () => {
    const tool = (name: string): GrantedTool => ({
      name,
      ref: `shopify/${name}`,
      description: "",
      parameters: z.object({}),
      execute: async () => "ok",
    });
    const guidance = grantedToolGuidance(
      [tool("mcp__shopify__GET_SHOP"), tool("mcp__shopify__LIST_ORDERS")],
      ["shopify"],
      new Set(["mcp__shopify__LIST_ORDERS"]),
    );
    expect(guidance).toContain(
      `- shopify: GET_SHOP, 1 more tools you find with ${SEARCH_TOOLS}`,
    );
    expect(guidance).not.toContain("LIST_ORDERS");
    expect(guidance).not.toContain("You hold none of their tools");
  });
});

describe("the pre-flight count", () => {
  test("leaves out what waits behind search", () => {
    expect(
      toolNamesSent(
        {
          model: "openai/gpt-5.5",
          tools: [
            { name: "remember", description: "", parameters: z.object({}) },
            { name: "APP_1", description: "", parameters: z.object({}) },
          ],
        },
        { tools: [] },
        new Set(["APP_1"]),
      ).sort(),
    ).toEqual(["remember", ...RUNTIME_STATE_TOOLS].sort());
  });

  test("applies where the runtime calls Chat Completions, and not on the Responses API or Anthropic", () => {
    const gpt = { provider: "openai" as const, defaultModel: "gpt-5.5" };
    expect(toolLimitFor(gpt, "sk-test")).toBeNull();
    process.env.OPENAI_BASE_URL = "https://gateway.example.com/v1";
    expect(toolLimitFor(gpt, "sk-test")).toEqual({
      provider: "OpenAI",
      limit: MODEL_TOOL_LIMIT,
    });
    process.env.COPILOTKIT_OPENAI_API = "responses";
    expect(toolLimitFor(gpt, "sk-test")).toBeNull();
    expect(
      toolLimitFor(
        { provider: "anthropic", defaultModel: "claude-sonnet-5-5" },
        "sk-test",
      ),
    ).toBeNull();
  });

  test("the refusal says what happened and who can fix it", () => {
    expect(
      toolLimitRefusal("General Assistant", 131, {
        provider: "OpenAI",
        limit: 128,
      }),
    ).toBe(
      "General Assistant can't answer. It needs 131 tools at once, and its OpenAI model takes at most 128. An admin can remove some of its apps on the Bot's page.",
    );
  });

  test("on Chat Completions, 279 app tools go through, because they wait behind search", async () => {
    process.env.OPENAI_BASE_URL = "https://gateway.example.com/v1";
    const recorded: Parameters<RecordToolLimitRefusal>[] = [];
    const script = scriptedProvider("chat", [{ text: "Hello." }]);
    try {
      const seen = await events(
        await assistant(
          await heldTools([]),
          { provider: "openai", defaultModel: "gpt-5.5" },
          recorded,
        ),
        input([asked]),
      );
      expect(seen.map((event) => event.type)).not.toContain(
        EventType.RUN_ERROR,
      );
      expect(recorded).toEqual([]);
    } finally {
      script.restore();
    }
  });

  test("on Chat Completions, a Bot whose own tools are past the limit is refused, recorded, and never sent", async () => {
    process.env.OPENAI_BASE_URL = "https://gateway.example.com/v1";
    const recorded: Parameters<RecordToolLimitRefusal>[] = [];
    const script = scriptedProvider("chat", [{ text: "Hello." }]);
    const own = Array.from({ length: 130 }, (_, index) => ({
      ...remember,
      name: `own_${index}`,
    }));
    try {
      const seen = await events(
        await assistant(
          own,
          { provider: "openai", defaultModel: "gpt-5.5" },
          recorded,
        ),
        input([asked]),
      );
      expect(seen.map((event) => event.type)).toEqual([
        EventType.RUN_STARTED,
        EventType.RUN_ERROR,
      ]);
      expect((seen[1] as { code?: string }).code).toBe(TOOL_LIMIT_EXCEEDED);
      expect(script.sent).toEqual([]);
      expect(recorded).toEqual([
        [
          generalAssistant.id,
          {
            tools: 130 + RUNTIME_STATE_TOOLS.length,
            limit: MODEL_TOOL_LIMIT,
            provider: "OpenAI",
          },
        ],
      ]);
    } finally {
      script.restore();
    }
  });
});
