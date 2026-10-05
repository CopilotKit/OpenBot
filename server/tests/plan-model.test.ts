import { expect, test } from "bun:test";
import { z } from "zod";
import {
  PLAN_RUN_COMPLETED,
  PlanModel,
  planMessages,
  planModelForEnvironment,
} from "../src/agents/plan-model";
import { buildAgents } from "../src/copilot";

test("a plan-only built-in keeps its identity and instructions", async () => {
  const requests: Record<string, unknown>[] = [];
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const body = await request.json();
      requests.push(body);
      const events = [
        { type: "RUN_STARTED", threadId: body.threadId, runId: body.runId },
        { type: "TEXT_MESSAGE_START", messageId: "reply", role: "assistant" },
        {
          type: "TEXT_MESSAGE_CONTENT",
          messageId: "reply",
          delta: "Plan-backed Knowledge.",
        },
        { type: "TEXT_MESSAGE_END", messageId: "reply" },
        { type: "RUN_FINISHED", threadId: body.threadId, runId: body.runId },
      ];
      return new Response(
        events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
        {
          headers: { "content-type": "text/event-stream" },
        },
      );
    },
  });
  try {
    const agents = await buildAgents(
      [
        {
          id: "knowledge",
          name: "Knowledge",
          type: "built_in",
          systemPrompt: "Cite the supplied knowledge sources.",
        },
      ],
      {
        provider: "openai",
        defaultModel: "unused-api-model",
        plan: {
          provider: "chatgpt",
          endpoint: server.url,
          token: "deployment-test-token",
        },
      },
      null,
    );
    const agent = agents.knowledge.clone();
    agent.setMessages([
      {
        id: "question",
        role: "user",
        content: "What is in our knowledge base?",
      },
    ]);
    await agent.runAgent({ runId: "original-run" });
    expect(agent.messages.at(-1)).toMatchObject({
      content: "Plan-backed Knowledge.",
    });
    expect(requests).toHaveLength(1);
    expect(JSON.stringify(requests[0])).toContain(
      "Cite the supplied knowledge sources.",
    );
  } finally {
    server.stop(true);
  }
});

test("frontend continuation keeps its SDK thread; Stop cancels only that Bot's query", async () => {
  const requests: Record<string, unknown>[] = [];
  const cancelled = Promise.withResolvers<string>();
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const body = await request.json();
      if (new URL(request.url).pathname.endsWith("/cancel")) {
        cancelled.resolve(body.threadId);
        return Response.json({ ok: true });
      }
      requests.push(body);
      return new Response(
        [
          { type: "RUN_STARTED", threadId: body.threadId, runId: body.runId },
          {
            type: "TOOL_CALL_START",
            toolCallId: "chart-call",
            toolCallName: "show_chart",
          },
          { type: "TOOL_CALL_ARGS", toolCallId: "chart-call", delta: "{}" },
          { type: "TOOL_CALL_END", toolCallId: "chart-call" },
          { type: "RUN_FINISHED", threadId: body.threadId, runId: body.runId },
        ]
          .map((event) => `data: ${JSON.stringify(event)}\n\n`)
          .join(""),
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  try {
    const config = {
      provider: "claude" as const,
      endpoint: server.url,
      token: "owned",
    };
    const options = {
      prompt: [
        {
          role: "user" as const,
          content: [{ type: "text" as const, text: "Show a chart" }],
        },
      ],
      tools: [
        {
          type: "function" as const,
          name: "show_chart",
          inputSchema: { type: "object" as const, properties: {} },
        },
      ],
    };
    const firstSignal = new AbortController();
    const first = new PlanModel(
      config,
      "knowledge",
      { threadId: "channel" },
      new Set(["show_chart"]),
      firstSignal.signal,
    );
    await first.doGenerate(options);
    firstSignal.abort(PLAN_RUN_COMPLETED);
    const nextSignal = new AbortController();
    const resumed = new PlanModel(
      config,
      "knowledge",
      { threadId: "channel" },
      new Set(["show_chart"]),
      nextSignal.signal,
    );
    await resumed.doGenerate(options);
    const differentBot = new PlanModel(config, "general-assistant", {
      threadId: "channel",
    });
    await differentBot.doGenerate(options);
    expect(requests[0]?.threadId).toBe(requests[1]?.threadId);
    expect(requests[2]?.threadId).not.toBe(requests[0]?.threadId);
    nextSignal.abort();
    expect(await cancelled.promise).toBe(requests[1]?.threadId);
  } finally {
    // Let the in-flight cancellation response finish before closing its socket.
    server.stop();
  }
});

test("the bridge refuses an unoffered native tool instead of executing it", async () => {
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const body = await request.json();
      return new Response(
        [
          { type: "RUN_STARTED", threadId: body.threadId, runId: body.runId },
          {
            type: "TOOL_CALL_START",
            toolCallId: "native",
            toolCallName: "Bash",
          },
        ]
          .map((event) => `data: ${JSON.stringify(event)}\n\n`)
          .join(""),
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  try {
    const model = new PlanModel(
      { provider: "claude", endpoint: server.url, token: "owned" },
      "knowledge",
      { threadId: "channel" },
    );
    await expect(
      model.doGenerate({
        prompt: [
          { role: "user", content: [{ type: "text", text: "Read source" }] },
        ],
      }),
    ).rejects.toThrow("unoffered tool: Bash");
  } finally {
    server.stop(true);
  }
});

test("the original built-in executes its granted tool and sends the actual matching result", async () => {
  const requests: Record<string, unknown>[] = [];
  const executions: string[] = [];
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const body = await request.json();
      expect(request.headers.get("x-openbot-agent-token")).toBe("owned-token");
      requests.push(body);
      const events =
        requests.length === 1
          ? [
              {
                type: "TOOL_CALL_START",
                toolCallId: "sdk-actual-id",
                toolCallName: "knowledge_search",
              },
              {
                type: "TOOL_CALL_ARGS",
                toolCallId: "sdk-actual-id",
                delta: '{"query":"policy"}',
              },
              { type: "TOOL_CALL_END", toolCallId: "sdk-actual-id" },
            ]
          : [
              {
                type: "TEXT_MESSAGE_START",
                messageId: "answer",
                role: "assistant",
              },
              {
                type: "TEXT_MESSAGE_CONTENT",
                messageId: "answer",
                delta: "Policy 42 [source].",
              },
              { type: "TEXT_MESSAGE_END", messageId: "answer" },
            ];
      return new Response(
        [
          { type: "RUN_STARTED", threadId: body.threadId, runId: body.runId },
          ...events,
          { type: "RUN_FINISHED", threadId: body.threadId, runId: body.runId },
        ]
          .map((event) => `data: ${JSON.stringify(event)}\n\n`)
          .join(""),
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  try {
    const agents = await buildAgents(
      [
        {
          id: "knowledge",
          name: "Knowledge",
          type: "built_in",
          systemPrompt: "Cite every retrieved source.",
        },
      ],
      {
        provider: "openai",
        defaultModel: "unused",
        plan: {
          provider: "claude",
          endpoint: server.url,
          token: "owned-token",
        },
      },
      "stale-api-key-must-not-be-used",
      undefined,
      async (id) => [
        {
          name: "knowledge_search",
          description: "Search granted knowledge",
          parameters: z.object({ query: z.string() }),
          ref: { kind: "mcp", serverId: "knowledge", toolName: "search" },
          execute: async (args) => {
            executions.push(id);
            return JSON.stringify({
              query: args,
              policy: 42,
              source: "granted-source",
            });
          },
        },
      ],
    );
    const agent = agents.knowledge.clone();
    agent.setMessages([{ id: "q", role: "user", content: "Find the policy." }]);
    await agent.runAgent();
    expect(executions).toEqual(["knowledge"]);
    expect(requests).toHaveLength(2);
    expect(requests[0]?.threadId).toBe(requests[1]?.threadId);
    expect(requests[1]?.messages).toContainEqual(
      expect.objectContaining({
        role: "tool",
        toolCallId: "sdk-actual-id",
        content: expect.stringContaining("granted-source"),
      }),
    );
    expect(requests[0]?.forwardedProps).toEqual({
      openbotModelOnly: true,
      openbotBotId: "knowledge",
    });
    expect(agent.messages.at(-1)).toMatchObject({
      content: "Policy 42 [source].",
    });
  } finally {
    server.stop(true);
  }
});

test("plan selection requires the matching deployment-owned harness and does not reinterpret API keys", () => {
  expect(
    planModelForEnvironment({ OPENAI_API_KEY: "ordinary-key" }),
  ).toBeUndefined();
  const selected = {
    CHATGPT_AUTH_FILE: "/owned/auth.json",
    PICKED_HARNESS_SOURCE: "installed",
    PICKED_HARNESS_IMAGE:
      "ghcr.io/copilotkit/openbot/agent-langgraph-agui:0.0.13",
    PICKED_HARNESS_URL: "http://127.0.0.1:9876/ag-ui",
    MANAGED_AGENT_TOKEN: "owned",
  };
  expect(planModelForEnvironment(selected)?.provider).toBe("chatgpt");
  expect(
    planModelForEnvironment({
      ...selected,
      PICKED_HARNESS_IMAGE:
        "ghcr.io/copilotkit/openbot-agent-langgraph-agui@sha256:6489cdcff5dc1b4f4d8fd34f0bd1b3e68019fd6c6249e8327097c16b5faac183",
    })?.provider,
  ).toBe("chatgpt");
  expect(() =>
    planModelForEnvironment({ ...selected, PICKED_HARNESS_SOURCE: "byo" }),
  ).toThrow("installed");
  expect(() =>
    planModelForEnvironment({
      ...selected,
      PICKED_HARNESS_IMAGE: "unrelated:latest",
    }),
  ).toThrow("installed");
  expect(() =>
    planModelForEnvironment({ ...selected, MANAGED_AGENT_TOKEN: "" }),
  ).toThrow("token");
});

test("model input preserves user images and exact parallel tool-result IDs", () => {
  expect(
    planMessages([
      {
        role: "user",
        content: [
          {
            type: "file",
            mediaType: "image/png",
            data: new Uint8Array([1, 2, 3]),
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolName: "search",
            toolCallId: "second",
            output: { type: "text", value: "second result" },
          },
          {
            type: "tool-result",
            toolName: "search",
            toolCallId: "first",
            output: { type: "text", value: "first result" },
          },
        ],
      },
    ]),
  ).toEqual([
    {
      id: "prompt-0",
      role: "user",
      content: [
        {
          type: "binary",
          mimeType: "image/png",
          url: "data:image/png;base64,AQID",
        },
      ],
    },
    {
      id: "result-second",
      role: "tool",
      toolCallId: "second",
      content: "second result",
    },
    {
      id: "result-first",
      role: "tool",
      toolCallId: "first",
      content: "first result",
    },
  ]);
});

test("image bytes cross the pinned JS/Python protocol boundary without becoming text", async () => {
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const body = await request.json();
      expect(body.messages[0].content).toEqual([
        {
          type: "image",
          source: { type: "data", mimeType: "image/png", value: "AQID" },
        },
      ]);
      return new Response(
        [
          { type: "RUN_STARTED", threadId: body.threadId, runId: body.runId },
          { type: "MESSAGES_SNAPSHOT", messages: body.messages },
          { type: "RUN_FINISHED", threadId: body.threadId, runId: body.runId },
        ]
          .map((event) => `data: ${JSON.stringify(event)}\n\n`)
          .join(""),
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  try {
    const model = new PlanModel(
      { provider: "claude", endpoint: server.url, token: "owned" },
      "knowledge",
      { threadId: "channel" },
    );
    await model.doGenerate({
      prompt: [
        {
          role: "user",
          content: [
            {
              type: "file",
              mediaType: "image/png",
              data: new Uint8Array([1, 2, 3]),
            },
          ],
        },
      ],
    });
  } finally {
    server.stop(true);
  }
});
