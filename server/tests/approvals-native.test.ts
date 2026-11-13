import { expect, spyOn, test } from "bun:test";
import { HeadlessToolSuspension } from "@openbot/toolkit/headless-tools";
import { z } from "zod";
import { currentApprovalContext } from "../src/approvals/types";
import { buildAgents } from "../src/copilot";

test("a real built-in native tool carries provider call identity and suspends AG-UI without a fake tool result", async () => {
  const transport = spyOn(globalThis, "fetch").mockImplementation(
    async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      return new Response(
        [
          { type: "RUN_STARTED", threadId: body.threadId, runId: body.runId },
          {
            type: "TOOL_CALL_START",
            toolCallId: "provider-write-call",
            toolCallName: "mcp__files__save",
            parentMessageId: "provider-message",
          },
          {
            type: "TOOL_CALL_ARGS",
            toolCallId: "provider-write-call",
            delta: '{"path":"report.txt"}',
          },
          { type: "TOOL_CALL_END", toolCallId: "provider-write-call" },
          { type: "RUN_FINISHED", threadId: body.threadId, runId: body.runId },
        ]
          .map((event) => `data: ${JSON.stringify(event)}\n\n`)
          .join(""),
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  );
  const captured: unknown[] = [],
    events: unknown[] = [];
  try {
    const agents = await buildAgents(
      [
        {
          id: "bot",
          name: "Bot",
          type: "built_in",
          systemPrompt: "Save the requested report.",
        },
      ],
      {
        provider: "openai",
        defaultModel: "unused",
        plan: {
          provider: "chatgpt",
          endpoint: new URL("https://owned.example/ag-ui"),
          token: "test-owned",
        },
      },
      null,
      undefined,
      async () => [
        {
          name: "mcp__files__save",
          ref: "files/save",
          description: "Save file",
          parameters: z.object({ path: z.string() }),
          initiator: { kind: "routine", id: "routine" },
          execute: async () => {
            const context = currentApprovalContext();
            captured.push(context);
            throw new HeadlessToolSuspension("Waiting for approval", {
              kind: "approval",
              approvalId: "approval",
              requestId: "approval",
              continuation: context,
            });
          },
        },
      ],
    );
    const agent = agents.bot;
    if (!agent) throw new Error("missing agent");
    agent.threadId = "canonical-thread";
    agent.setMessages([
      { id: "request", role: "user", content: "Save report" },
    ]);
    await agent.runAgent(
      {
        runId: "canonical-run",
        context: [{ description: "Project", value: "42" }],
      },
      {
        onEvent: ({ event }) => {
          events.push(event);
        },
      },
    );
    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({
      runId: "canonical-run",
      threadId: "canonical-thread",
      toolCallId: "provider-write-call",
      toolName: "mcp__files__save",
      args: { path: "report.txt" },
      initiator: { kind: "routine", id: "routine" },
      context: [{ description: "Project", value: "42" }],
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "CUSTOM",
        name: "openbot.headless.waiting",
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "RUN_FINISHED",
        outcome: expect.objectContaining({ type: "interrupt" }),
      }),
    );
    expect(events).not.toContainEqual(
      expect.objectContaining({ type: "TOOL_CALL_RESULT" }),
    );
    expect(events).not.toContainEqual(
      expect.objectContaining({ type: "RUN_ERROR" }),
    );
  } finally {
    transport.mockRestore();
  }
});

/**
 * A built-in Bot asks for two app changes in one step: rename a sheet's first tab, and add a tab.
 * The AI SDK starts both at once. The rename waits for the person; the add is allowed and goes on to
 * the app. The run stops for the rename only once every call it started has settled, so the add has
 * been done by then, and its result is the conversation's: the Bot told it "Not run" added the tab
 * again (found live, a sheet left with "Summary_2" and "How to Use_2").
 */
test("a call that finishes after another in its step stops the run still answers with its own result", async () => {
  const transport = spyOn(globalThis, "fetch").mockImplementation((async (
    _url: unknown,
    init?: RequestInit,
  ) => {
    const body = JSON.parse(String(init?.body));
    const call = (id: string, name: string, args: string) => [
      {
        type: "TOOL_CALL_START",
        toolCallId: id,
        toolCallName: name,
        parentMessageId: "provider-message",
      },
      { type: "TOOL_CALL_ARGS", toolCallId: id, delta: args },
      { type: "TOOL_CALL_END", toolCallId: id },
    ];
    return new Response(
      [
        { type: "RUN_STARTED", threadId: body.threadId, runId: body.runId },
        ...call("call-rename", "sheets_rename_tab", '{"title":"Template"}'),
        ...call("call-add", "sheets_add_tab", '{"title":"Summary"}'),
        { type: "RUN_FINISHED", threadId: body.threadId, runId: body.runId },
      ]
        .map((event) => `data: ${JSON.stringify(event)}\n\n`)
        .join(""),
      { headers: { "content-type": "text/event-stream" } },
    );
  }) as unknown as typeof fetch);
  const added: string[] = [];
  const events: { type: string; toolCallId?: string; content?: string }[] = [];
  try {
    const agents = await buildAgents(
      [
        {
          id: "bot",
          name: "Bot",
          type: "built_in",
          systemPrompt: "Build the sheet.",
        },
      ],
      {
        provider: "openai",
        defaultModel: "unused",
        plan: {
          provider: "chatgpt",
          endpoint: new URL("https://owned.example/ag-ui"),
          token: "test-owned",
        },
      },
      null,
      undefined,
      async () => [
        {
          name: "sheets_rename_tab",
          ref: "sheets/rename_tab",
          description: "Rename a tab",
          parameters: z.object({ title: z.string() }),
          execute: async () => {
            const context = currentApprovalContext();
            // The gate reads the person's rules before it asks.
            await new Promise((resolve) => setTimeout(resolve, 5));
            throw new HeadlessToolSuspension("Waiting for approval", {
              kind: "approval",
              approvalId: "approval",
              requestId: "approval",
              continuation: context,
            });
          },
        },
        {
          name: "sheets_add_tab",
          ref: "sheets/add_tab",
          description: "Add a tab",
          parameters: z.object({ title: z.string() }),
          execute: async (args: unknown) => {
            // The app takes longer to answer than the gate takes to ask.
            await new Promise((resolve) => setTimeout(resolve, 40));
            added.push((args as { title: string }).title);
            return "Added the Summary tab.";
          },
        },
      ],
    );
    const agent = agents.bot;
    if (!agent) throw new Error("missing agent");
    agent.threadId = "canonical-thread";
    agent.setMessages([
      { id: "request", role: "user", content: "Build the template" },
    ]);
    await agent.runAgent(
      { runId: "canonical-run" },
      {
        onEvent: ({ event }) => {
          events.push(event as (typeof events)[number]);
        },
      },
    );
    // The add was done.
    expect(added).toEqual(["Summary"]);
    // So the conversation holds what it came back with, before the run stops for the rename.
    const result = events.findIndex(
      (event) =>
        event.type === "TOOL_CALL_RESULT" && event.toolCallId === "call-add",
    );
    expect(result).toBeGreaterThan(-1);
    // As the AI SDK's own result would have read: the tool's answer, as JSON.
    expect(events[result]?.content).toBe(
      JSON.stringify("Added the Summary tab."),
    );
    const stopped = events.findIndex((event) => event.type === "RUN_FINISHED");
    expect(result).toBeLessThan(stopped);
    expect(events[stopped]).toMatchObject({
      outcome: { type: "interrupt" },
    });
    // The rename, which waits, has no result.
    expect(events).not.toContainEqual(
      expect.objectContaining({
        type: "TOOL_CALL_RESULT",
        toolCallId: "call-rename",
      }),
    );
  } finally {
    transport.mockRestore();
  }
});
