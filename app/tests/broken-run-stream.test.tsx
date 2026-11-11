import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
import type { Message, RunAgentInput } from "@ag-ui/core";
import { RunAgentInputSchema } from "@ag-ui/core/schemas";
import { CopilotKitProvider, useFrontendTool } from "@copilotkit/react-core/v2";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { type InfiniteData, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ChannelChat } from "@/components/channels/channel-chat";
import {
  type AgentChannel,
  type ChannelPage,
  channelKeys,
} from "@/lib/channels/queries";
import { UNANSWERED } from "@/lib/copilot/repair-history";
import { queryClient } from "@/query-client";

/**
 * A run whose live stream reaches the browser out of shape is read back from the thread, and the
 * turn goes on.
 *
 * Seen on Windows in 1.0.2-rc.1, both in one conversation with the built-in Bot on its harness. The
 * gateway that streams a run to the browser sent what it had stored of the run so far as one
 * compacted block, then the events after it; the events of a batch are stored out of order, so the
 * block held only some pieces of the reply, and the original start of the message still arrived
 * after it. AG-UI refuses a second start for a message already open, so the run failed in the
 * browser while it went fine on the server, and the thread stored it whole:
 *
 * - A reply drew as "ows httpbin's JSON echo of the second other fields are empty." and stayed so
 *   until a reload, which showed the whole sentence.
 * - A run that asked for three browser steps at once drew one, "Not completed", took none, and the
 *   turn ended there with nothing said, until the person typed "carry on".
 *
 * This fixture plays the runtime at the HTTP boundary, as `channel-failed-run-restore.test.tsx`
 * does: `/run` streams each planned run, a broken one exactly as the gateway's block and the events
 * after it reached the browser, and `/threads/:id/messages` answers with what the thread stored.
 * Everything above that boundary is the real provider, the real ChannelChat and the real transcript.
 */

type ChannelCache = InfiniteData<ChannelPage>;
const NativeResponse = globalThis.Response;
const channel: AgentChannel = {
  id: "broken-stream-channel",
  name: "Broken stream",
  agentIds: ["broken-stream-bot"],
  threadId: "broken-stream-thread",
  active: true,
  lastMessageAt: "2026-11-10T00:00:00.000Z",
};

/** The stored reply, word for word from the Windows run's thread. */
const WHOLE =
  'After you submit, the page shows httpbin\'s JSON echo of the second order. It lists custname "Gina G7 two", custtel "555-0102" and size "medium". The other fields are empty.';
/** Its eight pieces, as the Bot streamed them, in order. */
const PIECES = [
  "After you submit, the page sh",
  "ows httpbin's JS",
  "ON echo of the second",
  ' order. It lists custname "',
  'Gina G7 two",',
  ' custtel "555-0102',
  '" and size "medium". The',
  " other fields are empty.",
];
/** What the gateway's block held: the pieces stored first, which were the 2nd, 3rd and 8th. */
const BLOCK = [PIECES[1], PIECES[2], PIECES[7]].join("");

const STEP = "fixture_type";

/** How the next `/run` goes. */
type RunPlan =
  | { kind: "calls" }
  | { kind: "answers"; text: string }
  | { kind: "breaks-reply" }
  | { kind: "breaks-steps" };

let originalFetch: typeof fetch;
let plans: RunPlan[] = [];
let runs: RunAgentInput[] = [];
let stored = new Map<string, Message[]>();
let stepsTaken: string[] = [];

function sse(events: unknown[]) {
  return new NativeResponse(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
}
function remember(threadId: string, messages: Message[]) {
  const known = stored.get(threadId) ?? [];
  const ids = new Set(known.map((message) => message.id));
  stored.set(threadId, [
    ...known,
    ...messages.filter((message) => !ids.has(message.id)),
  ]);
}

function run(input: RunAgentInput): Response {
  runs.push(input);
  const plan = plans.shift();
  if (!plan) throw new Error("A run nobody planned for");
  // Everything the run was sent is stored, as the runtime stores a run's input it does not hold.
  remember(input.threadId, input.messages);
  const started = {
    type: "RUN_STARTED",
    threadId: input.threadId,
    runId: input.runId,
  };
  const finished = {
    type: "RUN_FINISHED",
    threadId: input.threadId,
    runId: input.runId,
  };
  if (plan.kind === "calls") {
    const toolCallId = `open-${input.runId}`;
    const args = JSON.stringify({ url: "https://httpbin.org/forms/post" });
    remember(input.threadId, [
      {
        id: `asks-${input.runId}`,
        role: "assistant",
        toolCalls: [
          {
            id: toolCallId,
            type: "function",
            function: { name: STEP, arguments: args },
          },
        ],
      },
    ]);
    return sse([
      started,
      {
        type: "TOOL_CALL_START",
        toolCallId,
        toolCallName: STEP,
        parentMessageId: `asks-${input.runId}`,
      },
      { type: "TOOL_CALL_ARGS", toolCallId, delta: args },
      { type: "TOOL_CALL_END", toolCallId },
      finished,
    ]);
  }
  if (plan.kind === "answers") {
    const messageId = `reply-${input.runId}`;
    remember(input.threadId, [
      { id: messageId, role: "assistant", content: plan.text },
    ]);
    return sse([
      started,
      { type: "TEXT_MESSAGE_START", messageId, role: "assistant" },
      { type: "TEXT_MESSAGE_CONTENT", messageId, delta: plan.text },
      { type: "TEXT_MESSAGE_END", messageId },
      finished,
    ]);
  }
  if (plan.kind === "breaks-reply") {
    const messageId = `lc_run--${input.runId}`;
    // The thread holds the reply whole, its pieces in their order.
    remember(input.threadId, [
      { id: messageId, role: "assistant", content: WHOLE },
    ]);
    return sse([
      started,
      // The gateway's compacted block: the pieces it had stored, as one.
      { type: "TEXT_MESSAGE_START", messageId, role: "assistant" },
      { type: "TEXT_MESSAGE_CONTENT", messageId, delta: BLOCK },
      // Then the message's own start, which the block did not hold, and what followed it.
      { type: "TEXT_MESSAGE_START", messageId, role: "assistant" },
      { type: "TEXT_MESSAGE_CONTENT", messageId, delta: PIECES[0] },
      { type: "TEXT_MESSAGE_END", messageId },
      {
        type: "MESSAGES_SNAPSHOT",
        messages: [{ id: messageId, role: "assistant", content: WHOLE }],
      },
      finished,
    ]);
  }
  // Three browser steps at once: fill in two fields and pick a size.
  const asks = `lc_run--${input.runId}`;
  const calls = [
    { id: `type-name-${input.runId}`, field: "Customer name", value: "Gina" },
    { id: `type-phone-${input.runId}`, field: "Telephone", value: "555-0101" },
    { id: `pick-size-${input.runId}`, field: "Size", value: "Small" },
  ].map((call) => ({
    id: call.id,
    type: "function" as const,
    function: {
      name: STEP,
      arguments: JSON.stringify({ field: call.field, value: call.value }),
    },
  }));
  remember(input.threadId, [{ id: asks, role: "assistant", toolCalls: calls }]);
  const first = calls[0];
  if (!first) throw new Error("No call");
  const cut = first.function.arguments.slice(0, 12);
  return sse([
    started,
    // The block held the first call's start and some of its arguments.
    {
      type: "TOOL_CALL_START",
      toolCallId: first.id,
      toolCallName: STEP,
      parentMessageId: asks,
    },
    { type: "TOOL_CALL_ARGS", toolCallId: first.id, delta: cut },
    { type: "TOOL_CALL_END", toolCallId: first.id },
    // The rest of its arguments arrived after the block had closed it.
    {
      type: "TOOL_CALL_ARGS",
      toolCallId: first.id,
      delta: first.function.arguments.slice(12),
    },
    finished,
  ]);
}

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/" });
  originalFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = new URL(
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url,
        "http://localhost",
      );
      const request = () =>
        input instanceof Request ? input : new Request(url, init);
      if (url.pathname === "/api/agents")
        return NativeResponse.json({ agents: [] });
      if (url.pathname === "/api/plugins/for/broken-stream-bot")
        return NativeResponse.json({ skills: [], tools: [] });
      if (url.pathname === "/api/agents/broken-stream-bot")
        return NativeResponse.json({
          agent: {
            id: "broken-stream-bot",
            visibility: "public",
            canManage: true,
          },
        });
      if (url.pathname === "/api/components/for-agent/broken-stream-bot")
        return NativeResponse.json({ components: [] });
      if (url.pathname === "/api/admin/enterprise/me")
        return NativeResponse.json({ capabilities: {}, enforced: false });
      if (url.pathname.endsWith("/info"))
        return NativeResponse.json({
          version: "fixture",
          agents: {
            "broken-stream-bot": { description: "Fixture", capabilities: {} },
          },
          mode: "sse",
          telemetryDisabled: true,
        });
      if (url.pathname.endsWith("/connect")) return sse([]);
      if (url.pathname.endsWith("/run"))
        return run(RunAgentInputSchema.parse(await request().json()));
      if (/\/api\/channels\/[^/]+\/(activity|busy)$/.test(url.pathname))
        return new NativeResponse(null, { status: 204 });
      if (url.pathname === "/api/voice/sessions")
        return NativeResponse.json({ sessions: [], nextCursor: null });
      const thread = url.pathname.match(/\/threads\/([^/]+)\/messages$/);
      if (thread)
        return NativeResponse.json({
          messages: stored.get(decodeURIComponent(thread[1] ?? "")) ?? [],
        });
      throw new Error(`Unexpected fixture request: ${url.pathname}`);
    },
    {
      preconnect() {
        throw new Error("Unexpected fixture preconnect");
      },
    },
  );
});
// The query cache is the app's own singleton: start from nothing another file left in it.
beforeEach(() => queryClient.clear());
afterEach(() => {
  cleanup();
  queryClient.clear();
  plans = [];
  runs = [];
  stored = new Map();
  stepsTaken = [];
});
afterAll(() => {
  globalThis.fetch = originalFetch;
  GlobalRegistrator.unregister();
});

/** A browser step, as the computer's tools are: it runs here and the turn goes on. */
function BrowserStep() {
  useFrontendTool({
    name: STEP,
    description: "A step the browser carries out.",
    handler: async (args: Record<string, unknown>) => {
      stepsTaken.push(JSON.stringify(args));
      return { ok: true };
    },
  });
  return null;
}

function open() {
  queryClient.setQueryData<ChannelCache>(channelKeys.list(), {
    pages: [
      {
        channels: [
          {
            ...channel,
            summary: null,
            lastMessage: null,
            lastMessageAgentId: null,
            createdAt: "2026-11-10T00:00:00.000Z",
            pinned: false,
            lastReadAt: null,
          },
        ],
        nextCursor: null,
      },
    ],
    pageParams: [""],
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <CopilotKitProvider runtimeUrl="http://localhost/api/copilotkit">
        <BrowserStep />
        <ChannelChat
          channel={channel}
          key={channel.id}
          runtimeAgentId="broken-stream-bot"
        />
      </CopilotKitProvider>
    </QueryClientProvider>,
  );
}
async function send(view: ReturnType<typeof open>, text: string) {
  const user = userEvent.setup({ document: view.container.ownerDocument });
  const box = await view.findByRole("textbox", { name: "Message" });
  await user.clear(box);
  await user.type(box, text);
  await user.click(view.getByRole("button", { name: "Send message" }));
}
async function idle(view: ReturnType<typeof open>) {
  await waitFor(
    () =>
      expect(view.queryByRole("button", { name: "Stop the Bot" })).toBeNull(),
    { timeout: 8000 },
  );
}

test("a reply whose stream broke after a browser step is drawn whole, as the thread stored it", async () => {
  plans = [{ kind: "calls" }, { kind: "breaks-reply" }];
  const view = open();
  await send(view, "Order a pizza on httpbin and tell me what the page shows");
  await view.findByText(WHOLE, undefined, { timeout: 8000 });
  await idle(view);
  expect(view.queryByText(BLOCK)).toBeNull();
  expect(view.queryByTestId("transcript-stopped")).toBeNull();
  expect(runs).toHaveLength(2);
});

test("browser steps a broken stream never took are answered as not run, and the Bot carries on", async () => {
  plans = [
    { kind: "calls" },
    { kind: "breaks-steps" },
    { kind: "answers", text: "I filled in the form." },
  ];
  const view = open();
  await send(view, "Fill in the pizza form");
  await view.findByText("I filled in the form.", undefined, { timeout: 8000 });
  await idle(view);
  expect(view.queryByTestId("transcript-stopped")).toBeNull();

  // Only the first run's step was taken here: none of the broken run's three, cut short or not.
  expect(stepsTaken).toEqual([
    JSON.stringify({ url: "https://httpbin.org/forms/post" }),
  ]);
  // The run that carried on was sent all three, whole, each answered as not run.
  expect(runs).toHaveLength(3);
  const carried = runs[2]?.messages ?? [];
  const asked = carried.find(
    (message) =>
      message.role === "assistant" && (message.toolCalls?.length ?? 0) === 3,
  );
  expect(
    asked?.role === "assistant"
      ? asked.toolCalls?.map((call) => JSON.parse(call.function.arguments))
      : null,
  ).toEqual([
    { field: "Customer name", value: "Gina" },
    { field: "Telephone", value: "555-0101" },
    { field: "Size", value: "Small" },
  ]);
  const answers = carried.filter(
    (message) =>
      message.role === "tool" &&
      asked?.role === "assistant" &&
      asked.toolCalls?.some((call) => call.id === message.toolCallId),
  );
  expect(answers.map((message) => message.content)).toEqual([
    UNANSWERED,
    UNANSWERED,
    UNANSWERED,
  ]);
});
