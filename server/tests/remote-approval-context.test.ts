import { expect, spyOn, test } from "bun:test";
import { HttpAgent, type RunAgentInput } from "@ag-ui/client";
import { HeadlessToolSuspension } from "@openbot/toolkit/headless-tools";
import { of } from "rxjs";
import { z } from "zod";
import { currentApprovalContext } from "../src/approvals/types";
import { buildAgents } from "../src/copilot";

async function fixture(
  answered = false,
  toolName = "mcp__vendor__write",
  suspend = true,
) {
  const requests: RunAgentInput[] = [];
  const run = spyOn(HttpAgent.prototype, "run").mockImplementation((input) => {
    requests.push(input);
    return of(
      { type: "RUN_STARTED", threadId: input.threadId, runId: input.runId },
      { type: "STATE_SNAPSHOT", snapshot: { real: "provider-state" } },
      {
        type: "TOOL_CALL_START",
        toolCallId: "provider-call",
        toolCallName: toolName,
        parentMessageId: "provider-message",
      },
      {
        type: "TOOL_CALL_ARGS",
        toolCallId: "provider-call",
        delta: '{"value":"actual"}',
      },
      { type: "TOOL_CALL_END", toolCallId: "provider-call" },
      ...(answered
        ? [
            {
              type: "TOOL_CALL_RESULT" as const,
              messageId: "backend-result",
              toolCallId: "provider-call",
              content: "backend already executed",
              role: "tool" as const,
            },
          ]
        : []),
      { type: "RUN_FINISHED", threadId: input.threadId, runId: input.runId },
    );
  });
  let context: ReturnType<typeof currentApprovalContext>;
  let calls = 0;
  const args: Parameters<typeof buildAgents> = [
    [
      {
        id: "remote",
        name: "Remote",
        type: "remote_ag_ui",
        endpoint: "https://remote.test/ag-ui",
        standingMessage: {
          id: "standing-role:remote",
          role: "system",
          content: "Remote job",
        },
      },
    ],
    { provider: "openai", defaultModel: "test" },
    null,
  ];
  args[toolName === "ask_person" ? 10 : 4] = async () => [
    {
      name: toolName,
      ref: "vendor/write",
      description: "Write with approval",
      parameters: z.object({ value: z.string() }),
      execute: async () => {
        calls += 1;
        context = currentApprovalContext();
        if (!suspend) return "question saved";
        throw new HeadlessToolSuspension("Approve write", {
          kind: "approval",
          requestId: "request",
        });
      },
    },
  ];
  let signatures = 0;
  args[5] = () =>
    ++signatures === 1 ? "signed-original-run" : `signed-segment-${signatures}`;
  const agent = (await buildAgents(...args)).remote;
  if (!agent) throw new Error("Missing fixture agent");
  agent.threadId = "canonical-thread";
  agent.messages = [
    { id: "person-message", role: "user", content: "Write actual" },
  ];
  return { run, requests, agent, calls: () => calls, context: () => context };
}

test("remote client tool captures real provider call and canonical conversation before approval suspension", async () => {
  const f = await fixture();
  try {
    const result = await f.agent.runAgent({
      runId: "canonical-run",
      forwardedProps: { original: true },
    });
    expect(f.calls()).toBe(1);
    expect(f.context()).toMatchObject({
      runId: "canonical-run",
      threadId: "canonical-thread",
      toolCallId: "provider-call",
      toolName: "mcp__vendor__write",
      args: { value: "actual" },
      state: { real: "provider-state" },
      forwardedProps: { openbotRun: "signed-original-run" },
    });
    expect(
      f
        .context()
        ?.messages.some(
          (message) =>
            message.role === "assistant" &&
            message.toolCalls?.some((call) => call.id === "provider-call"),
        ),
    ).toBe(true);
    expect(f.requests[0]?.forwardedProps.openbotDeploymentTools).toEqual([]);
    expect(result.newMessages.some((message) => message.role === "tool")).toBe(
      false,
    );
  } finally {
    f.run.mockRestore();
  }
});

test("backend answered remote tool calls are forwarded without duplicate execution", async () => {
  const f = await fixture(true);
  try {
    await f.agent.runAgent({ runId: "canonical-run" });
    expect(f.calls()).toBe(0);
  } finally {
    f.run.mockRestore();
  }
});

for (const answered of [false, true]) {
  test(`remote question ${answered ? "already answered is not repeated" : "executes as a client tool with provider context"}`, async () => {
    const f = await fixture(answered, "ask_person");
    try {
      await f.agent.runAgent({ runId: "canonical-run" });
      expect(f.calls()).toBe(answered ? 0 : 1);
      expect(f.requests[0]?.forwardedProps.openbotDeploymentTools).toEqual([
        "ask_person",
      ]);
      if (!answered) expect(f.context()?.toolName).toBe("ask_person");
    } finally {
      f.run.mockRestore();
    }
  });
}

test("remote question result continues the same run without executing the call twice", async () => {
  const f = await fixture(false, "ask_person", false);
  try {
    await f.agent.runAgent({ runId: "canonical-run" });
    expect(f.calls()).toBe(1);
    expect(f.requests).toHaveLength(2);
    expect(f.requests[1]?.runId).toBe("canonical-run");
    expect(f.requests[1]?.forwardedProps.openbotRun).toBe(
      "signed-original-run",
    );
    expect(f.requests[1]?.messages.at(-1)).toMatchObject({
      role: "tool",
      toolCallId: "provider-call",
      content: "question saved",
    });
  } finally {
    f.run.mockRestore();
  }
});
