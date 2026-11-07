import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
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
import { queryClient } from "@/query-client";

/**
 * A conversation whose last run failed still says so after a reload.
 *
 * The failure arrives as a RUN_ERROR, an event, and the thread's stored messages hold only what was
 * said. So the red line under the person's message lived in the screen's memory: reload, or come
 * back later, and the message sat there unanswered with nothing to say why.
 *
 * The runtime keeps every run's events and replays them, run after run, when the conversation joins
 * its thread. That replay is where the failure is read back from. This fixture plays the runtime at
 * the HTTP boundary the way the runtime behaves: `/run` streams a run and records its events, and
 * `/connect` replays every recorded run back to back, as the runners do (the in-memory runner's
 * `connect`, and the Intelligence gateway's per-run replay). Everything above that boundary is the
 * real provider, the real ChannelChat and the real transcript.
 */

type ChannelCache = InfiniteData<ChannelPage>;
const NativeResponse = globalThis.Response;
const channel: AgentChannel = {
  id: "failed-run-channel",
  name: "Failed run",
  agentIds: ["failed-run-bot"],
  threadId: "failed-run-thread",
  active: true,
  lastMessageAt: "2026-11-06T00:00:00.000Z",
};
const other: AgentChannel = {
  ...channel,
  id: "other-channel",
  name: "Another conversation",
  threadId: "other-thread",
};
/** What the model provider said when it refused the key, word for word. */
const REJECTED = "invalid x-api-key";

/** How the next `/run` goes. A fresh one per test. */
type RunPlan =
  | { kind: "fails"; message: string }
  | { kind: "calls"; tool: string }
  | { kind: "answers"; text: string }
  | { kind: "stalls"; text: string };

let originalFetch: typeof fetch;
let plans: RunPlan[] = [];
/** Every event the runtime has streamed for a thread, run after run: what `/connect` replays. */
let recorded = new Map<string, unknown[]>();
/** The thread's stored messages: what was said, and nothing about how a run ended. */
let stored = new Map<string, Message[]>();
let stopRequests: string[] = [];
/** The open stream of a stalled run, for the stop that ends it. */
let stalled: {
  input: RunAgentInput;
  messageId: string;
  finish: (events: unknown[]) => void;
} | null = null;

function frames(events: unknown[]) {
  return events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
}
function sse(events: unknown[]) {
  return new NativeResponse(frames(events), {
    headers: { "content-type": "text/event-stream" },
  });
}
function record(threadId: string, events: unknown[]) {
  recorded.set(threadId, [...(recorded.get(threadId) ?? []), ...events]);
}
function remember(threadId: string, messages: Message[]) {
  const known = stored.get(threadId) ?? [];
  const ids = new Set(known.map((message) => message.id));
  stored.set(threadId, [
    ...known,
    ...messages.filter((message) => !ids.has(message.id)),
  ]);
}

/** One run, as the runtime streams it and records it. */
function run(input: RunAgentInput): Response {
  const plan = plans.shift();
  if (!plan) throw new Error("A run nobody planned for");
  const started = {
    type: "RUN_STARTED",
    threadId: input.threadId,
    runId: input.runId,
  };
  // The person's message is stored whatever the run comes to.
  remember(
    input.threadId,
    input.messages.filter((message) => message.role === "user"),
  );
  if (plan.kind === "calls") {
    // A step the browser carries out, as a Bot's run ends on one: the call, then RUN_FINISHED.
    const toolCallId = `call-${input.runId}`;
    const events = [
      started,
      {
        type: "TOOL_CALL_START",
        toolCallId,
        toolCallName: plan.tool,
        parentMessageId: `asks-${input.runId}`,
      },
      { type: "TOOL_CALL_ARGS", toolCallId, delta: "{}" },
      { type: "TOOL_CALL_END", toolCallId },
      { type: "RUN_FINISHED", threadId: input.threadId, runId: input.runId },
    ];
    record(input.threadId, events);
    return sse(events);
  }
  if (plan.kind === "fails") {
    const events = [
      started,
      { type: "RUN_ERROR", message: plan.message, code: "agent_error" },
    ];
    record(input.threadId, events);
    return sse(events);
  }
  const messageId = `reply-${input.runId}`;
  const reply = [
    { type: "TEXT_MESSAGE_START", messageId, role: "assistant" },
    { type: "TEXT_MESSAGE_CONTENT", messageId, delta: plan.text },
  ];
  if (plan.kind === "answers") {
    const events = [
      started,
      ...reply,
      { type: "TEXT_MESSAGE_END", messageId },
      { type: "RUN_FINISHED", threadId: input.threadId, runId: input.runId },
    ];
    record(input.threadId, events);
    remember(input.threadId, [
      { id: messageId, role: "assistant", content: plan.text },
    ]);
    return sse(events);
  }
  // Stalls: streams the start of an answer and waits, as a Bot still thinking does.
  const opening = [started, ...reply];
  let close: (events: unknown[]) => void = () => {
    throw new Error("Stream not started");
  };
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      controller.enqueue(encoder.encode(frames(opening)));
      close = (events) => {
        controller.enqueue(encoder.encode(frames(events)));
        controller.close();
      };
    },
  });
  stalled = {
    input,
    messageId,
    finish: (events) => {
      record(input.threadId, [...opening, ...events]);
      remember(input.threadId, [
        { id: messageId, role: "assistant", content: plan.text },
      ]);
      close(events);
    },
  };
  return new NativeResponse(body, {
    headers: { "content-type": "text/event-stream" },
  });
}

beforeAll(() => {
  // At an origin, as a page is: a Stop is posted to a URL resolved against it.
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
      if (url.pathname === "/api/plugins/for/failed-run-bot")
        return NativeResponse.json({ skills: [], tools: [] });
      if (url.pathname === "/api/agents/failed-run-bot")
        return NativeResponse.json({
          agent: {
            id: "failed-run-bot",
            visibility: "public",
            canManage: true,
          },
        });
      if (url.pathname === "/api/components/for-agent/failed-run-bot")
        return NativeResponse.json({ components: [] });
      if (url.pathname === "/api/admin/enterprise/me")
        return NativeResponse.json({ capabilities: {}, enforced: false });
      if (url.pathname.endsWith("/info"))
        return NativeResponse.json({
          version: "fixture",
          agents: {
            "failed-run-bot": { description: "Fixture", capabilities: {} },
          },
          mode: "sse",
          telemetryDisabled: true,
        });
      if (url.pathname.endsWith("/connect")) {
        const body = (await request().json()) as { threadId?: string };
        return sse(recorded.get(body.threadId ?? "") ?? []);
      }
      if (url.pathname.endsWith("/run"))
        return run(RunAgentInputSchema.parse(await request().json()));
      /*
       * A stop, as the runtime carries it out: the runner closes what the run left open and ends it
       * with RUN_FINISHED, outcome cancelled, never a RUN_ERROR (`finalizeRunEvents` in
       * @copilotkit/shared, with `stopRequested`).
       */
      const stop = url.pathname.match(/\/agent\/[^/]+\/stop\/([^/]+)$/);
      if (stop) {
        stopRequests.push(decodeURIComponent(stop[1] ?? ""));
        const open = stalled;
        stalled = null;
        open?.finish([
          { type: "TEXT_MESSAGE_END", messageId: open.messageId },
          {
            type: "RUN_FINISHED",
            threadId: open.input.threadId,
            runId: open.input.runId,
            outcome: { type: "cancelled" },
          },
        ]);
        return NativeResponse.json({ stopped: true });
      }
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
afterEach(() => {
  cleanup();
  queryClient.clear();
  plans = [];
  recorded = new Map();
  stored = new Map();
  stopRequests = [];
  stalled = null;
  stepsRun = 0;
});
afterAll(() => {
  globalThis.fetch = originalFetch;
  GlobalRegistrator.unregister();
});

/** A step the browser answers, as the computer's tools are: it runs here and the turn goes on. */
const STEP = "fixture_step";
let stepsRun = 0;
function BrowserStep() {
  useFrontendTool({
    name: STEP,
    description: "A step the browser carries out.",
    handler: async () => {
      stepsRun += 1;
      return { ok: false, reason: "The button is not on the page any more." };
    },
  });
  return null;
}

function conversation(selected: AgentChannel) {
  return (
    <QueryClientProvider client={queryClient}>
      <CopilotKitProvider runtimeUrl="http://localhost/api/copilotkit">
        <BrowserStep />
        {/* Keyed as the channel route keys it, so another conversation is a fresh mount. */}
        <ChannelChat
          channel={selected}
          key={selected.id}
          runtimeAgentId="failed-run-bot"
        />
      </CopilotKitProvider>
    </QueryClientProvider>
  );
}
/** A page load: a fresh provider, so nothing is carried over from the last one but the server. */
function open(selected = channel) {
  queryClient.setQueryData<ChannelCache>(channelKeys.list(), {
    pages: [
      {
        channels: [channel, other].map((row) => ({
          ...row,
          summary: null,
          lastMessage: null,
          lastMessageAgentId: null,
          createdAt: "2026-11-06T00:00:00.000Z",
          pinned: false,
          lastReadAt: null,
        })),
        nextCursor: null,
      },
    ],
    pageParams: [""],
  });
  return render(conversation(selected));
}
async function send(view: ReturnType<typeof open>, text: string) {
  const user = userEvent.setup({ document: view.container.ownerDocument });
  const box = await view.findByRole("textbox", { name: "Message" });
  await user.clear(box);
  await user.type(box, text);
  await user.click(view.getByRole("button", { name: "Send message" }));
  return user;
}
/** Settled: the history is in and the composer is open again. */
async function settled(view: ReturnType<typeof open>, said: string) {
  await view.findByText(said);
  await waitFor(() =>
    expect(view.queryByRole("button", { name: "Stop the Bot" })).toBeNull(),
  );
}

test.each(["a reload", "coming back from another conversation"])(
  "a conversation whose last run failed shows that failure again after %s, as it did live",
  async (how) => {
    plans = [{ kind: "fails", message: REJECTED }];
    const live = open();
    await send(live, "Summarise my inbox");
    const shown = await live.findByTestId("transcript-stopped");
    expect(shown.textContent).toBe(REJECTED);
    const liveMarkup = shown.outerHTML;

    let back: ReturnType<typeof open>;
    if (how === "a reload") {
      live.unmount();
      back = open();
    } else {
      live.rerender(conversation(other));
      await waitFor(() =>
        expect(live.queryByTestId("transcript-stopped")).toBeNull(),
      );
      live.rerender(conversation(channel));
      back = live;
    }
    await settled(back, "Summarise my inbox");
    const restored = await back.findByTestId("transcript-stopped");
    // In its own words, in the same place, drawn the same way.
    expect(restored.textContent).toBe(REJECTED);
    expect(restored.outerHTML).toBe(liveMarkup);
  },
);

test("a failure that a later run answered is not shown after a reload", async () => {
  plans = [
    { kind: "fails", message: REJECTED },
    { kind: "answers", text: "Here is your inbox summary." },
  ];
  const live = open();
  await send(live, "Summarise my inbox");
  await live.findByTestId("transcript-stopped");
  await send(live, "Try again");
  await live.findByText("Here is your inbox summary.");
  expect(live.queryByTestId("transcript-stopped")).toBeNull();

  live.unmount();
  const back = open();
  await settled(back, "Here is your inbox summary.");
  // The replay has to be all the way in before its silence means anything.
  await waitFor(() => expect(back.queryByText("Try again")).not.toBeNull());
  expect(back.queryByTestId("transcript-stopped")).toBeNull();
  expect(back.queryByText(REJECTED)).toBeNull();
});

test("a run the person stopped is not shown as a failure, live or after a reload", async () => {
  plans = [{ kind: "stalls", text: "Reading your inbox" }];
  const live = open();
  const user = await send(live, "Summarise my inbox");
  await live.findByText("Reading your inbox");
  await user.click(await live.findByRole("button", { name: "Stop the Bot" }));
  await waitFor(() => expect(stopRequests).toEqual([channel.threadId]));
  await waitFor(() =>
    expect(live.queryByRole("button", { name: "Stop the Bot" })).toBeNull(),
  );
  expect(live.queryByTestId("transcript-stopped")).toBeNull();

  live.unmount();
  const back = open();
  await settled(back, "Summarise my inbox");
  await back.findByText("Reading your inbox");
  expect(back.queryByTestId("transcript-stopped")).toBeNull();
});

test("a turn that fails in a run after its browser steps says so, as one that fails at once does", async () => {
  // The Bot works through browser steps, each answered here and sent back in a run of its own, and
  // the run after the last of them fails. That turn used to end on its steps with nothing said.
  const OUT_OF_TIME = "The Claude query timed out after 300s.";
  plans = [
    { kind: "calls", tool: STEP },
    { kind: "calls", tool: STEP },
    { kind: "fails", message: OUT_OF_TIME },
  ];
  const live = open();
  await send(live, "Sign me up on the garden form");
  const shown = await live.findByTestId("transcript-stopped");
  expect(shown.textContent).toBe(OUT_OF_TIME);
  expect(stepsRun).toBe(2);
  await waitFor(() =>
    expect(live.queryByRole("button", { name: "Stop the Bot" })).toBeNull(),
  );
});
