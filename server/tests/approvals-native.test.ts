import { expect, spyOn, test } from "bun:test";
import { z } from "zod";
import { buildAgents } from "../src/copilot";
import { currentApprovalContext } from "../src/approvals/types";
import { HeadlessToolSuspension } from "../src/computer/headless-tools";

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
