import { expect, test } from "bun:test";
import type { RunAgentInput } from "@ag-ui/client";
import { BuiltInAgentWithSaneHistory } from "@openbot/toolkit/copilotkit/agents";
import { parametersFor } from "@openbot/toolkit/granted-tool";
import { PlanModel } from "../src/agents/plan-model";

for (const provider of ["chatgpt", "claude"] as const) {
  test(`${provider} plan answers on its last step instead of searching again`, async () => {
    const requests: RunAgentInput[] = [];
    const server = Bun.serve({
      port: 0,
      fetch: async (request) => {
        const body: RunAgentInput = await request.json();
        requests.push(body);
        const id = `search-${requests.length}`;
        const events = body.tools.length
          ? [
              {
                type: "TOOL_CALL_START",
                toolCallId: id,
                toolCallName: "search",
              },
              { type: "TOOL_CALL_ARGS", toolCallId: id, delta: "{}" },
              { type: "TOOL_CALL_END", toolCallId: id },
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
                delta: "Here is what I found.",
              },
              { type: "TEXT_MESSAGE_END", messageId: "answer" },
            ];
        return new Response(
          [
            { type: "RUN_STARTED", threadId: body.threadId, runId: body.runId },
            ...events,
            {
              type: "RUN_FINISHED",
              threadId: body.threadId,
              runId: body.runId,
            },
          ]
            .map((event) => `data: ${JSON.stringify(event)}\n\n`)
            .join(""),
          {
            headers: { "content-type": "text/event-stream" },
          },
        );
      },
    });
    try {
      const model = new PlanModel(
        { provider, endpoint: server.url, token: "owned-test-token" },
        "knowledge",
        { threadId: "channel" },
      );
      const agent = new BuiltInAgentWithSaneHistory(
        {
          model,
          maxSteps: 3,
          tools: [
            {
              name: "search",
              description: "Search sources",
              parameters: parametersFor({ type: "object", properties: {} }),
              execute: async () => "A collected source.",
            },
          ],
        },
        { observe: (run) => run },
      );
      agent.threadId = "channel";
      agent.setMessages([
        { id: "ask", role: "user", content: "Find sources." },
      ]);
      await agent.runAgent();
      expect(agent.messages.at(-1)).toMatchObject({
        content: "Here is what I found.",
      });
      expect(requests).toHaveLength(3);
      expect(
        requests
          .slice(0, 2)
          .every((request) =>
            request.tools.some((tool) => tool.name === "search"),
          ),
      ).toBe(true);
      expect(requests[2]?.tools).toEqual([]);
      expect(requests[2]?.forwardedProps).toMatchObject({
        openbotAnswerOnly: true,
      });
      expect(JSON.stringify(requests[2]?.messages)).toContain(
        "A collected source.",
      );
    } finally {
      server.stop(true);
    }
  });
}
