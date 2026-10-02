import { afterAll, afterEach, beforeAll, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render } from "@testing-library/react";

/**
 * The handler the SDK keeps for a computer change.
 *
 * The SDK registers a frontend tool's handler once and never re-registers it when the handler's
 * closure changes, so anything the handler reads from render time is frozen at first render. The
 * handler used to read the "Ask before making changes" switch that way, saw it still loading, and
 * sent every change straight to the computer outside any run; the server then answered "This action
 * needs an authenticated run before it can be approved." This drives the handler the SDK actually
 * kept, captured at first render, with no inbox loaded at all.
 */

const real = await import("@copilotkit/react-core/v2");
type Registered = Parameters<typeof real.useFrontendTool>[0];
const registered: Registered[] = [];
const stopped: unknown[] = [];
mock.module("@copilotkit/react-core/v2", () => ({
  ...real,
  useCopilotKit: () => ({
    copilotkit: { stopAgent: (input: unknown) => stopped.push(input) },
  }),
  useFrontendTool: (tool: Registered) => {
    if (!registered.some((entry) => entry.name === tool.name))
      registered.push(tool);
  },
}));
const { useFrontendTool } = await import("@/lib/copilot/approval-tools");
const { observeApprovalAgent } = await import("@/lib/copilot/approval-context");

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

const direct: unknown[] = [];
function Tools() {
  useFrontendTool({
    name: "computer_click",
    description: "Click",
    handler: async (args: Record<string, unknown>) => {
      direct.push(args);
      return { clicked: true };
    },
  });
  return null;
}

test("a change goes to the server's gate even when nothing about approvals has loaded", async () => {
  const posted: { path: string; body: unknown }[] = [];
  const originalFetch = global.fetch;
  global.fetch = Object.assign(
    async (path: Parameters<typeof fetch>[0], init?: RequestInit) => {
      posted.push({
        path: String(path),
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      return Response.json(
        { waiting: true, approvalId: "approval-1" },
        { status: 202 },
      );
    },
    { preconnect: originalFetch.preconnect },
  );
  try {
    const queries = new QueryClient();
    const invalidated: unknown[] = [];
    const invalidate = queries.invalidateQueries.bind(queries);
    queries.invalidateQueries = ((filters?: unknown) => {
      invalidated.push(filters);
      return invalidate(filters as never);
    }) as typeof queries.invalidateQueries;
    render(
      <QueryClientProvider client={queries}>
        <Tools />
      </QueryClientProvider>,
    );
    const tool = registered.find((entry) => entry.name === "computer_click");
    // The shape of the SDK's agent the handler reads: its subscriber hooks, thread and history.
    const toolCall = {
      id: "click-call",
      type: "function" as const,
      function: {
        name: "computer_click",
        arguments: '{"ref":"e7","snapshotId":3}',
      },
    };
    const subscribers: {
      onRunInitialized?: (input: { input: unknown }) => void;
    }[] = [];
    const agent = {
      threadId: "thread",
      state: {},
      messages: [
        { id: "u1", role: "user", content: "Submit the form" },
        { id: "a1", role: "assistant", content: "", toolCalls: [toolCall] },
      ],
      subscribe: (subscriber: (typeof subscribers)[number]) => {
        subscribers.push(subscriber);
        return { unsubscribe: () => undefined };
      },
    };
    const stop = observeApprovalAgent(agent as never);
    for (const subscriber of subscribers)
      subscriber.onRunInitialized?.({
        input: {
          runId: "run-1",
          threadId: "thread",
          messages: agent.messages,
          tools: [],
          context: [],
          state: {},
          forwardedProps: {},
        },
      });
    const result = await tool?.handler?.({ ref: "e7", snapshotId: 3 }, {
      agent,
      toolCall,
    } as never);
    stop();
    expect(direct).toEqual([]);
    expect(posted).toEqual([
      {
        path: "/api/approvals/computer/default",
        body: expect.objectContaining({
          runId: "run-1",
          threadId: "thread",
          toolCallId: "click-call",
          toolName: "computer_click",
          args: { ref: "e7", snapshotId: 3 },
        }),
      },
    ]);
    expect(result).toEqual({ waiting: true });
    expect(stopped).toHaveLength(1);
    // The card is drawn now, not on the inbox's next poll.
    expect(invalidated).toEqual([{ queryKey: ["approvals"] }]);
  } finally {
    global.fetch = originalFetch;
  }
});
