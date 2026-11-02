import { afterAll, afterEach, beforeAll, expect, spyOn, test } from "bun:test";
import * as ReactCoreV2 from "@copilotkit/react-core/v2";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render } from "@testing-library/react";
import { failedComputerCall } from "@/lib/computers/call";
import { observeApprovalAgent } from "@/lib/copilot/approval-context";
import { useFrontendTool } from "@/lib/copilot/approval-tools";

/**
 * The handler the SDK keeps for a computer change.
 *
 * The SDK registers a frontend tool's handler once and never re-registers it when the handler's
 * closure changes, so anything the handler reads from render time is frozen at first render. The
 * handler used to read the "Ask before making changes" switch that way, saw it still loading, and
 * sent every change straight to the computer outside any run; the server then answered "This action
 * needs an authenticated run before it can be approved." This drives the handler the SDK actually
 * kept, captured at first render, with no inbox loaded at all.
 *
 * Spies on the module namespace rather than `mock.module`, because bun cannot take a module mock
 * back off: it would stay installed for every test file walked into the same process afterwards,
 * and those files would get this fake SDK instead of the real one. These spies are restored below.
 */

type Registered = Parameters<typeof ReactCoreV2.useFrontendTool>[0];
const registered: Registered[] = [];
const stopped: unknown[] = [];
const useCopilotKitSpy = spyOn(ReactCoreV2, "useCopilotKit").mockImplementation(
  () =>
    ({
      copilotkit: { stopAgent: (input: unknown) => stopped.push(input) },
    }) as never,
);
function register<T extends Record<string, unknown>>(
  tool: ReactCoreV2.ReactFrontendTool<T>,
) {
  if (!registered.some((entry) => entry.name === tool.name))
    registered.push(tool as unknown as Registered);
}
const useFrontendToolSpy = spyOn(
  ReactCoreV2,
  "useFrontendTool",
).mockImplementation(register);
afterAll(() => {
  useCopilotKitSpy.mockRestore();
  useFrontendToolSpy.mockRestore();
});

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

/**
 * Runs the kept computer_click handler against a gate that answers with `answer`.
 *
 * The SDK starts no follow-up run after a frontend tool throws (core's executeSpecificTool returns
 * false on a handler error), so a handler that throws ends the Bot's turn on the spot with nothing
 * said. A form field the computer could not fill did exactly that: the Bot opened a CRM form, failed
 * on one dropdown, and the conversation simply stopped.
 */
async function clickAgainstGate(
  answer: () => Promise<Response>,
): Promise<unknown> {
  const originalFetch = global.fetch;
  global.fetch = Object.assign(async () => answer(), {
    preconnect: originalFetch.preconnect,
  });
  try {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <Tools />
      </QueryClientProvider>,
    );
    const tool = registered.find((entry) => entry.name === "computer_click");
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
    try {
      return await tool?.handler?.({ ref: "e7", snapshotId: 3 }, {
        agent,
        toolCall,
      } as never);
    } finally {
      stop();
    }
  } finally {
    global.fetch = originalFetch;
  }
}

test("a change the computer could not make comes back to the Bot as a result, not a throw", async () => {
  const result = await clickAgainstGate(async () =>
    Response.json(
      {
        error:
          "Element e7 is not on the page any more. Take a fresh snapshot and use the refs from it.",
      },
      { status: 409 },
    ),
  );
  expect(result).toEqual({
    ok: false,
    reason:
      "Element e7 is not on the page any more. Take a fresh snapshot and use the refs from it.",
    staleRefs: true,
  });
});

test("a refused change comes back as a refusal the Bot can explain", async () => {
  const result = await clickAgainstGate(async () =>
    Response.json(
      { error: "Your team does not allow this.", rule: "team-rule-1" },
      { status: 403 },
    ),
  );
  expect(result).toEqual({
    ok: false,
    reason: "Your team does not allow this.",
    refused: true,
    rule: "team-rule-1",
  });
});

test("a gate that cannot be reached, or answers with no result, is still a result", async () => {
  expect(
    await clickAgainstGate(async () => {
      throw new TypeError("fetch failed");
    }),
  ).toEqual({
    ok: false,
    reason: "The assistant's computer could not be reached.",
  });
  expect(
    await clickAgainstGate(async () => Response.json({}, { status: 200 })),
  ).toEqual({ ok: false, reason: "The computer action returned no result." });
});

/*
 * A look at a page a rule asks about.
 *
 * A navigation goes straight to the computer, without the conversation the approval card is drawn
 * in, so a rule like "ask before opening pages" used to leave the gate nowhere to ask. The Bot was
 * handed the refusal and told the person "this browser action requires an approval flow that isn't
 * available in this chat". The computer now answers `needsConversation`, and the call goes again
 * through the gate, where it waits on the card like any change.
 */
let lookOutcome: unknown;
const looked: unknown[] = [];
function LookTools() {
  useFrontendTool({
    name: "computer_navigate",
    description: "Open a page",
    handler: async (args: Record<string, unknown>) => {
      looked.push(args);
      return lookOutcome;
    },
  });
  return null;
}

async function navigateWith(
  answer: (path: string) => Promise<Response>,
): Promise<{ result: unknown; paths: string[] }> {
  const paths: string[] = [];
  const originalFetch = global.fetch;
  global.fetch = Object.assign(
    async (path: Parameters<typeof fetch>[0]) => {
      paths.push(String(path));
      return answer(String(path));
    },
    { preconnect: originalFetch.preconnect },
  );
  try {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <LookTools />
      </QueryClientProvider>,
    );
    const tool = registered.find((entry) => entry.name === "computer_navigate");
    const toolCall = {
      id: "navigate-call",
      type: "function" as const,
      function: {
        name: "computer_navigate",
        arguments: '{"url":"https://example.com"}',
      },
    };
    const subscribers: {
      onRunInitialized?: (input: { input: unknown }) => void;
    }[] = [];
    const agent = {
      threadId: "thread",
      state: {},
      messages: [
        { id: "u1", role: "user", content: "Open example.com" },
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
    try {
      const result = await tool?.handler?.({ url: "https://example.com" }, {
        agent,
        toolCall,
      } as never);
      return { result, paths };
    } finally {
      stop();
    }
  } finally {
    global.fetch = originalFetch;
  }
}

test("a look a rule asks about goes again through the gate, with its conversation", async () => {
  looked.length = 0;
  stopped.length = 0;
  lookOutcome = failedComputerCall(409, {
    error: "This action needs your approval.",
    needsConversation: true,
    notPerformed: true,
  });
  const { result, paths } = await navigateWith(async () =>
    Response.json({ waiting: true, approvalId: "approval-2" }, { status: 202 }),
  );
  expect(looked).toHaveLength(1);
  expect(paths).toEqual(["/api/approvals/computer/default"]);
  expect(result).toEqual({ waiting: true });
  expect(stopped).toHaveLength(1);
});

test("a look nothing asks about goes straight to the computer and nowhere else", async () => {
  looked.length = 0;
  lookOutcome = { ok: true, title: "Example Domain" };
  const { result, paths } = await navigateWith(async () => {
    throw new Error("The gate should not be called.");
  });
  expect(looked).toHaveLength(1);
  expect(paths).toEqual([]);
  expect(result).toEqual({ ok: true, title: "Example Domain" });
});

test("needing a conversation is not read as stale refs", () => {
  expect(
    failedComputerCall(409, {
      error: "This action needs your approval.",
      needsConversation: true,
      notPerformed: true,
    }),
  ).toEqual({
    ok: false,
    needsConversation: true,
    notPerformed: true,
    reason: "This action needs your approval.",
  });
});
