import { afterAll, afterEach, beforeAll, expect, spyOn, test } from "bun:test";
import * as ReactCoreV2 from "@copilotkit/react-core/v2";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render } from "@testing-library/react";
import { failedComputerCall } from "@/lib/computers/call";
import { observeApprovalAgent } from "@/lib/copilot/approval-context";
import { useFrontendTool } from "@/lib/copilot/approval-tools";
import { problemResponse } from "./approvals-api";

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
  const posted: { path: string; body?: unknown }[] = [];
  const originalFetch = global.fetch;
  global.fetch = Object.assign(
    async (path: Parameters<typeof fetch>[0], init?: RequestInit) => {
      posted.push({
        path: String(path),
        ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
      });
      if (
        String(path).startsWith(
          "/api/v2/organizations/default/people/me/approval-modes/",
        )
      )
        return Response.json({ asksEveryStep: false });
      return Response.json({
        outcome: "waiting",
        approvalId: "approval-1",
        reason: "This action is waiting for your approval.",
      });
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
      onRunInitialized?: (input: {
        messages: unknown[];
        input: unknown;
      }) => void;
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
        messages: agent.messages,
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
      { path: "/api/v2/organizations/default/people/me/approval-modes/thread" },
      {
        path: "/api/v2/organizations/default/people/me/computer-steps",
        body: {
          botId: "default",
          conversation: expect.objectContaining({
            runId: "run-1",
            threadId: "thread",
            toolCallId: "click-call",
            toolName: "computer_click",
            args: { ref: "e7", snapshotId: 3 },
          }),
        },
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
  answer: (init?: RequestInit) => Promise<Response>,
): Promise<unknown> {
  const originalFetch = global.fetch;
  global.fetch = Object.assign(
    async (_url: unknown, init?: RequestInit) => answer(init),
    { preconnect: originalFetch.preconnect },
  );
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
      onRunInitialized?: (input: {
        messages: unknown[];
        input: unknown;
      }) => void;
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
        messages: agent.messages,
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
    problemResponse(
      409,
      "Element e7 is not on the page any more. Take a fresh snapshot and use the refs from it.",
    ),
  );
  expect(result).toEqual({
    ok: false,
    reason:
      "Element e7 is not on the page any more. Take a fresh snapshot and use the refs from it.",
    staleRefs: true,
    // Every answer says when it finished, for the time beside it in Activity (`withFinishedAt`).
    finishedAt: expect.any(String),
  });
});

test("a refused change comes back as a refusal the Bot can explain", async () => {
  const result = await clickAgainstGate(async () =>
    problemResponse(403, "Your team does not allow this."),
  );
  expect(result).toEqual({
    ok: false,
    reason: "Your team does not allow this.",
    refused: true,
    // A problem names no rule: the sentence is what the Bot has to explain it with.
    rule: null,
    finishedAt: expect.any(String),
  });
});

/*
 * A step on a computer that is still starting is asked again until it has started, as a direct call
 * is (`callComputer`), so the Bot gets what the step did. A cold computer answered the step "still
 * starting" after the server's wait, and the Bot was told to try again: the step's card read
 * "Computer starting" where the command and its output should have been.
 */
test("a step on a computer still starting is asked again, and the Bot gets what it did", async () => {
  const asked: string[] = [];
  const result = await clickAgainstGate(async () => {
    asked.push("step");
    return asked.length === 1
      ? Response.json({
          outcome: "done",
          result: {
            ok: false,
            starting: true,
            notPerformed: true,
            reason:
              "The computer is still starting. This call was not performed. Try it again in a moment.",
          },
        })
      : Response.json({
          outcome: "done",
          result: { ok: true, clicked: "e7" },
        });
  });
  expect(asked).toEqual(["step", "step"]);
  expect(result).toEqual({
    ok: true,
    clicked: "e7",
    finishedAt: expect.any(String),
  });
});

/*
 * A STEP THE SERVER HAS TAKEN IS NOT RUN TWICE. The server runs a Bot's computer steps itself, once,
 * whoever asks. A page that asks for one the server is running is told it is `taken` and still going,
 * asks again with the same step until the server's run answers, and that answer is the step's.
 */
test("a step the server is running is asked about again, never run here, and gets the server's answer", async () => {
  const asked: unknown[] = [];
  const understood: (string | null)[] = [];
  const result = await clickAgainstGate(async (init) => {
    asked.push("step");
    understood.push(new Headers(init?.headers).get("OpenBot-Capabilities"));
    return asked.length === 1
      ? Response.json({
          outcome: "taken",
          threadId: "thread",
          toolCallId: "click-call",
          running: true,
        })
      : Response.json({
          outcome: "taken",
          threadId: "thread",
          toolCallId: "click-call",
          running: false,
          result: { ok: true, clicked: "e7" },
        });
  });
  // Only the gate was asked, twice, and nothing went to the computer from here.
  expect(asked).toEqual(["step", "step"]);
  // Each time saying this page understands a step the server has taken (OpenBot-Capabilities).
  for (const value of understood)
    expect(value?.split(" ")).toContain("computer-step-taken");
  expect(result).toEqual({
    ok: true,
    clicked: "e7",
    finishedAt: expect.any(String),
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
    finishedAt: expect.any(String),
  });
  expect(
    await clickAgainstGate(async () => Response.json({ outcome: "done" })),
  ).toEqual({
    ok: false,
    reason: "The computer action returned no result.",
    finishedAt: expect.any(String),
  });
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

/**
 * One client for every look: the SDK keeps the handler from the first render, and the client with
 * it, as the app's one client is kept.
 */
const lookQueries = new QueryClient();
async function navigateWith(
  answer: (path: string) => Promise<Response>,
  { observed = true }: { observed?: boolean } = {},
): Promise<{ result: unknown; paths: string[] }> {
  const paths: string[] = [];
  // Each look starts from an app that has asked nothing about this conversation yet.
  lookQueries.clear();
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
      <QueryClientProvider client={lookQueries}>
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
      onRunInitialized?: (input: {
        messages: unknown[];
        input: unknown;
      }) => void;
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
    const stop = observed
      ? observeApprovalAgent(agent as never)
      : () => undefined;
    for (const subscriber of subscribers)
      subscriber.onRunInitialized?.({
        messages: agent.messages,
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

/** The server's answer to "does this conversation ask before every step?", then `rest` for the gate. */
const threadAnswers =
  (asksEveryStep: boolean, rest: () => Promise<Response>) =>
  async (path: string) =>
    path === "/api/v2/organizations/default/people/me/approval-modes/thread"
      ? Response.json({ asksEveryStep })
      : rest();

test("a look a rule asks about goes again through the gate, with its conversation", async () => {
  looked.length = 0;
  stopped.length = 0;
  lookOutcome = failedComputerCall(409, {
    error: "This action needs your approval.",
    needsConversation: true,
    notPerformed: true,
  });
  const { result, paths } = await navigateWith(
    threadAnswers(false, async () =>
      Response.json({
        outcome: "waiting",
        approvalId: "approval-2",
        reason: "This action is waiting for your approval.",
      }),
    ),
  );
  expect(looked).toHaveLength(1);
  expect(paths).toEqual([
    "/api/v2/organizations/default/people/me/approval-modes/thread",
    "/api/v2/organizations/default/people/me/computer-steps",
  ]);
  expect(result).toEqual({ waiting: true });
  expect(stopped).toHaveLength(1);
});

test("a look nothing asks about goes straight to the computer and nowhere else", async () => {
  looked.length = 0;
  lookOutcome = { ok: true, title: "Example Domain" };
  const { result, paths } = await navigateWith(
    threadAnswers(false, async () => {
      throw new Error("The gate should not be called.");
    }),
  );
  expect(looked).toHaveLength(1);
  // Asked once about the conversation, and the answer kept: it never changes.
  expect(paths).toEqual([
    "/api/v2/organizations/default/people/me/approval-modes/thread",
  ]);
  expect(result).toEqual({
    ok: true,
    title: "Example Domain",
    finishedAt: expect.any(String),
  });
});

test("in a task's own conversation, opened with no conversation list loaded, a look goes to the gate first", async () => {
  // A task opened by a link: the app holds no conversation list, so only the server can say.
  looked.length = 0;
  stopped.length = 0;
  lookOutcome = { ok: true, title: "Example Domain" };
  const { result, paths } = await navigateWith(
    threadAnswers(true, async () =>
      Response.json({
        outcome: "waiting",
        approvalId: "approval-3",
        reason: "This action is waiting for your approval.",
      }),
    ),
  );
  expect(looked).toEqual([]);
  expect(paths).toEqual([
    "/api/v2/organizations/default/people/me/approval-modes/thread",
    "/api/v2/organizations/default/people/me/computer-steps",
  ]);
  expect(result).toEqual({ waiting: true });
  expect(stopped).toHaveLength(1);
});

test("a look whose conversation couldn't be checked goes through the gate, where the server decides", async () => {
  looked.length = 0;
  lookOutcome = { ok: true, title: "Example Domain" };
  const { result, paths } = await navigateWith(async (path) =>
    path === "/api/v2/organizations/default/people/me/approval-modes/thread"
      ? Response.json({ error: "Unavailable." }, { status: 503 })
      : Response.json({
          outcome: "done",
          result: { ok: true, title: "Example Domain" },
        }),
  );
  expect(looked).toEqual([]);
  expect(paths).toEqual([
    "/api/v2/organizations/default/people/me/approval-modes/thread",
    "/api/v2/organizations/default/people/me/computer-steps",
  ]);
  expect(result).toEqual({
    ok: true,
    title: "Example Domain",
    finishedAt: expect.any(String),
  });
});

test("in a task's own conversation, a look with no conversation to ask in is not taken at all", async () => {
  looked.length = 0;
  lookOutcome = { ok: true, title: "Example Domain" };
  const { result, paths } = await navigateWith(
    threadAnswers(true, async () => {
      throw new Error("The gate should not be called.");
    }),
    { observed: false },
  );
  expect(looked).toEqual([]);
  expect(paths).toEqual([
    "/api/v2/organizations/default/people/me/approval-modes/thread",
  ]);
  expect(result).toEqual({
    ok: false,
    reason:
      "Not done: this conversation asks before every step, and this step couldn't be asked about here.",
    finishedAt: expect.any(String),
  });
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
