import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import {
  type Message,
  type RunAgentInput,
  RunAgentInputSchema,
} from "@ag-ui/core";
import { CopilotKitProvider, useCopilotKit } from "@copilotkit/react-core/v2";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { type InfiniteData, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { z } from "zod";
import { ChannelChat } from "@/components/channels/channel-chat";
import {
  type AgentChannel,
  type ChannelPage,
  type ChannelSummary,
  channelKeys,
} from "@/lib/channels/queries";
import { applyChannelEvent } from "@/lib/channels/use-channel-events";
import { queryClient } from "@/query-client";

type ChannelCache = InfiniteData<ChannelPage>;
const ActivityRequestSchema = z.object({
  agentId: z.string().nullable(),
  at: z.string(),
  text: z.string(),
});
type ActivityRequest = z.infer<typeof ActivityRequestSchema>;
const NativeResponse = globalThis.Response;
const channel: AgentChannel = {
  id: "refresh-channel",
  name: "Refresh test",
  agentIds: ["refresh-bot"],
  threadId: "refresh-thread",
  active: true,
  lastMessageAt: "2026-09-09T00:00:00.000Z",
};
const initial = {
  id: "initial",
  role: "assistant",
  content: "Stored opening",
} satisfies Message;
const fresh = {
  id: "fresh",
  role: "assistant",
  content: "Fresh stored reply",
} satisfies Message;
const local: Message = {
  id: "local",
  role: "user",
  content: "Local message stays",
};
const broken = { id: "broken", role: "user", content: null };
const unavailable =
  "Earlier messages are temporarily unavailable. You can keep using this conversation.";
const oneHole =
  "One earlier message could not be read and is not shown. The rest of this conversation is complete.";
let originalFetch: typeof fetch;
let history: (threadId: string) => Promise<Response>;
let historyReads: string[];
let gatewaySnapshot: readonly Message[] = [];
let runRequests: { path: string; input: RunAgentInput }[] = [];
let activityRequests: ActivityRequest[] = [];
let runEvents: (input: RunAgentInput) => unknown[];
let core: ReturnType<typeof useCopilotKit>["copilotkit"] | undefined;

function CoreProbe() {
  core = useCopilotKit().copilotkit;
  return null;
}
function stored(messages: unknown[]) {
  return NativeResponse.json({ messages });
}
function sse(events: unknown[]) {
  return new NativeResponse(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
    {
      headers: { "content-type": "text/event-stream" },
    },
  );
}

beforeAll(() => {
  GlobalRegistrator.register();
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
      if (url.pathname === "/api/agents")
        return NativeResponse.json({ agents: [] });
      if (url.pathname === "/api/plugins/for/refresh-bot")
        return NativeResponse.json({ skills: [], tools: [] });
      if (url.pathname.endsWith("/info"))
        return NativeResponse.json({
          version: "fixture",
          agents: {
            "refresh-bot": { description: "Fixture", capabilities: {} },
          },
          mode: "sse",
          telemetryDisabled: true,
        });
      if (url.pathname.endsWith("/connect"))
        return sse([
          { type: "RUN_STARTED", threadId: channel.threadId, runId: "join" },
          { type: "MESSAGES_SNAPSHOT", messages: gatewaySnapshot },
          { type: "RUN_FINISHED", threadId: channel.threadId, runId: "join" },
        ]);
      if (url.pathname.endsWith("/run")) {
        const request =
          input instanceof Request ? input : new Request(url, init);
        const body = RunAgentInputSchema.parse(await request.json());
        runRequests.push({ path: url.pathname, input: body });
        return sse(runEvents(body));
      }
      if (/\/api\/channels\/[^/]+\/activity$/.test(url.pathname)) {
        const request =
          input instanceof Request ? input : new Request(url, init);
        activityRequests.push(
          ActivityRequestSchema.parse(await request.json()),
        );
        return new NativeResponse(null, { status: 204 });
      }
      if (/\/api\/channels\/[^/]+\/busy$/.test(url.pathname))
        return new NativeResponse(null, { status: 204 });
      const match = url.pathname.match(/\/threads\/([^/]+)\/messages$/);
      if (match) {
        const threadId = match[1];
        if (!threadId) throw new Error("Missing fixture thread id");
        historyReads.push(threadId);
        return history(threadId);
      }
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
  core = undefined;
});
afterAll(() => {
  globalThis.fetch = originalFetch;
  GlobalRegistrator.unregister();
});

function tree(selected: AgentChannel) {
  return (
    <QueryClientProvider client={queryClient}>
      <CopilotKitProvider runtimeUrl="http://localhost/api/copilotkit">
        <CoreProbe />
        <ChannelChat channel={selected} runtimeAgentId="refresh-bot" />
      </CopilotKitProvider>
    </QueryClientProvider>
  );
}
function cacheChannel(selected: AgentChannel) {
  const summary: ChannelSummary = {
    ...selected,
    summary: null,
    lastMessage: null,
    lastMessageAgentId: "refresh-bot",
    createdAt: "2026-09-09T00:00:00.000Z",
    pinned: false,
    lastReadAt: null,
  };
  queryClient.setQueryData<ChannelCache>(channelKeys.list(), {
    pages: [{ channels: [summary], nextCursor: null }],
    pageParams: [""],
  });
}
function mounting(
  read: typeof history = async () => stored([initial]),
  snapshot: readonly Message[] = [],
) {
  historyReads = [];
  gatewaySnapshot = snapshot;
  runRequests = [];
  activityRequests = [];
  runEvents = (input) => [
    { type: "RUN_STARTED", threadId: input.threadId, runId: input.runId },
    { type: "RUN_FINISHED", threadId: input.threadId, runId: input.runId },
  ];
  history = read;
  cacheChannel(channel);
  return render(tree(channel));
}
async function mounted() {
  const view = mounting();
  await view.findByText("Stored opening");
  return view;
}
function currentAgent(selected = channel) {
  const agent = core?.getAgent(`channel:${selected.id}`);
  if (!agent) throw new Error("Mounted channel agent is not registered");
  return agent;
}
type ActivityFixture = { agentId?: string | null; text?: string; at?: string };

async function announce(
  at: number,
  selected = channel,
  activity: ActivityFixture = {},
) {
  await act(async () => {
    queryClient.setQueryData<ChannelCache>(channelKeys.list(), (cache) => {
      if (!cache) throw new Error("No mounted channel cache");
      const patched = applyChannelEvent(cache, {
        channelId: selected.id,
        lastMessage: activity.text ?? "Bot announced a turn",
        lastMessageAgentId:
          activity.agentId === undefined ? "refresh-bot" : activity.agentId,
        lastMessageAt:
          activity.at ?? `2026-09-09T00:00:${String(at).padStart(2, "0")}.000Z`,
      });
      if (patched === "unknown")
        throw new Error("Announced channel missing from cache");
      return patched;
    });
  });
}
function delayedResponse() {
  let resolve: (response: Response) => void = () => {
    throw new Error("Response not initialized");
  };
  const promise = new Promise<Response>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

// Real provider, ChannelChat, history reader, and query cache; only the HTTP boundary is synthetic.
test.each([
  { name: "partial gateway snapshot", snapshot: [initial] },
  { name: "empty gateway snapshot", snapshot: [] },
])(
  "a failed mount restore warns over $name and after a same-thread send",
  async ({ snapshot }) => {
    const view = mounting(
      async () => new NativeResponse("failed", { status: 500 }),
      snapshot,
    );
    await view.findByText(unavailable);
    if (snapshot.length > 0)
      expect(view.getByText(initial.content)).toBeTruthy();
    const user = userEvent.setup({ document: view.container.ownerDocument });
    await user.type(
      view.getByRole("textbox", { name: "Message" }),
      "Later local turn",
    );
    await user.click(view.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(runRequests).toHaveLength(1));
    expect(runRequests[0]?.path).toBe("/api/copilotkit/agent/refresh-bot/run");
    expect(runRequests[0]?.input.threadId).toBe(channel.threadId);
    expect(runRequests[0]?.input.messages.slice(0, snapshot.length)).toEqual([
      ...snapshot,
    ]);
    expect(runRequests[0]?.input.messages.at(-1)).toMatchObject({
      role: "user",
      content: "Later local turn",
    });
    expect(view.getByText(unavailable)).toBeTruthy();
    expect(view.queryByText(/different CopilotKit project/)).toBeNull();
  },
);

test("a same-tab activity echo does not append a lagging durable partial beside the completed local reply", async () => {
  const fullReply = {
    id: "streamed-full-reply",
    role: "assistant",
    content: "I can answer this fully from the live run.",
  } satisfies Message;
  const partialEcho = {
    id: "durable-lagging-partial",
    role: "assistant",
    content: "I can answer this fully",
  } satisfies Message;
  const view = mounting(async () => stored([initial]), [initial]);
  await view.findByText(initial.content);
  runEvents = (input) => [
    { type: "RUN_STARTED", threadId: input.threadId, runId: input.runId },
    {
      type: "TEXT_MESSAGE_START",
      messageId: fullReply.id,
      role: "assistant",
    },
    {
      type: "TEXT_MESSAGE_CONTENT",
      messageId: fullReply.id,
      delta: fullReply.content,
    },
    { type: "TEXT_MESSAGE_END", messageId: fullReply.id },
    { type: "RUN_FINISHED", threadId: input.threadId, runId: input.runId },
  ];

  const user = userEvent.setup({ document: view.container.ownerDocument });
  await user.type(
    view.getByRole("textbox", { name: "Message" }),
    "Ask for live answer",
  );
  await user.click(view.getByRole("button", { name: "Send message" }));
  await view.findByText(fullReply.content);
  await waitFor(() =>
    expect(
      activityRequests.some(
        (activity) =>
          activity.agentId === "refresh-bot" &&
          activity.text === fullReply.content,
      ),
    ).toBe(true),
  );
  const selfActivity = activityRequests.find(
    (activity) =>
      activity.agentId === "refresh-bot" && activity.text === fullReply.content,
  );
  if (!selfActivity) throw new Error("Missing self-reported Bot activity");
  history = async () => stored([initial, partialEcho]);
  await announce(1, channel, selfActivity);
  expect(historyReads).toHaveLength(1);

  expect(view.getByText(fullReply.content)).toBeTruthy();
  expect(view.queryByText(partialEcho.content)).toBeNull();
  expect(currentAgent().messages.map((message) => message.id)).toContain(
    fullReply.id,
  );
  expect(currentAgent().messages.map((message) => message.id)).not.toContain(
    partialEcho.id,
  );
});

test("a same-timestamp different activity after a self echo still refreshes durable history", async () => {
  const fullReply = {
    id: "local-live-reply",
    role: "assistant",
    content: "Local reply already rendered",
  } satisfies Message;
  const relayed = {
    id: "same-time-relayed-reply",
    role: "assistant",
    content: "Same timestamp relayed reply",
  } satisfies Message;
  const view = mounting(async () => stored([initial]), [initial]);
  await view.findByText(initial.content);
  runEvents = (input) => [
    { type: "RUN_STARTED", threadId: input.threadId, runId: input.runId },
    {
      type: "TEXT_MESSAGE_START",
      messageId: fullReply.id,
      role: "assistant",
    },
    {
      type: "TEXT_MESSAGE_CONTENT",
      messageId: fullReply.id,
      delta: fullReply.content,
    },
    { type: "TEXT_MESSAGE_END", messageId: fullReply.id },
    { type: "RUN_FINISHED", threadId: input.threadId, runId: input.runId },
  ];

  const user = userEvent.setup({ document: view.container.ownerDocument });
  await user.type(
    view.getByRole("textbox", { name: "Message" }),
    "Ask before same-time relay",
  );
  await user.click(view.getByRole("button", { name: "Send message" }));
  await view.findByText(fullReply.content);
  await waitFor(() =>
    expect(
      activityRequests.some(
        (activity) =>
          activity.agentId === "refresh-bot" &&
          activity.text === fullReply.content,
      ),
    ).toBe(true),
  );
  const selfActivity = activityRequests.find(
    (activity) =>
      activity.agentId === "refresh-bot" && activity.text === fullReply.content,
  );
  if (!selfActivity) throw new Error("Missing self-reported Bot activity");

  await announce(1, channel, selfActivity);
  expect(historyReads).toHaveLength(1);
  history = async () => stored([initial, relayed]);
  await announce(1, channel, {
    ...selfActivity,
    agentId: "relay-bot",
    text: "Different same-time relay",
  });

  await view.findByText(relayed.content);
  expect(historyReads).toHaveLength(2);
  expect(currentAgent().messages.map((message) => message.id)).toContain(
    relayed.id,
  );
});

test.each([
  { name: "different timestamp", override: { at: "2026-09-09T00:00:10.000Z" } },
  {
    name: "different text",
    override: { text: "A different Bot-authored update" },
  },
  { name: "different agent", override: { agentId: "relay-bot" } },
])(
  "a $name activity after a self report still refreshes durable history",
  async ({ override }) => {
    const fullReply = {
      id: "local-live-reply",
      role: "assistant",
      content: "Local reply already rendered",
    } satisfies Message;
    const relayed = {
      id: "relayed-durable-reply",
      role: "assistant",
      content: "Relayed durable reply",
    } satisfies Message;
    const view = mounting(async () => stored([initial]), [initial]);
    await view.findByText(initial.content);
    runEvents = (input) => [
      { type: "RUN_STARTED", threadId: input.threadId, runId: input.runId },
      {
        type: "TEXT_MESSAGE_START",
        messageId: fullReply.id,
        role: "assistant",
      },
      {
        type: "TEXT_MESSAGE_CONTENT",
        messageId: fullReply.id,
        delta: fullReply.content,
      },
      { type: "TEXT_MESSAGE_END", messageId: fullReply.id },
      { type: "RUN_FINISHED", threadId: input.threadId, runId: input.runId },
    ];

    const user = userEvent.setup({ document: view.container.ownerDocument });
    await user.type(
      view.getByRole("textbox", { name: "Message" }),
      "Ask before relay",
    );
    await user.click(view.getByRole("button", { name: "Send message" }));
    await view.findByText(fullReply.content);
    await waitFor(() =>
      expect(
        activityRequests.some(
          (activity) =>
            activity.agentId === "refresh-bot" &&
            activity.text === fullReply.content,
        ),
      ).toBe(true),
    );
    const selfActivity = activityRequests.find(
      (activity) =>
        activity.agentId === "refresh-bot" &&
        activity.text === fullReply.content,
    );
    if (!selfActivity) throw new Error("Missing self-reported Bot activity");

    history = async () => stored([initial, relayed]);
    await announce(1, channel, { ...selfActivity, ...override });
    await view.findByText(relayed.content);
    expect(historyReads).toHaveLength(2);
    expect(currentAgent().messages.map((message) => message.id)).toContain(
      relayed.id,
    );
  },
);

test("a ready durable mount adds the newer turn beyond the gateway snapshot", async () => {
  const view = mounting(async () => stored([initial, fresh]), [initial]);
  await view.findByText(fresh.content);
  expect(view.getByText(initial.content)).toBeTruthy();
  expect(view.queryByText(unavailable)).toBeNull();
  expect(currentAgent().messages.map((message) => message.id)).toEqual([
    "initial",
    "fresh",
  ]);
});

test.each([false, true])(
  "mount keeps a readable gateway tool result while restoring newer durable replies (longer store: %s)",
  async (longerStore) => {
    const toolCall = {
      id: "tool-call",
      role: "assistant",
      toolCalls: [
        {
          id: "call",
          type: "function",
          function: { name: "inspect", arguments: "{}" },
        },
      ],
    } satisfies Message;
    const toolResult = {
      id: "tool-result",
      role: "tool",
      toolCallId: "call",
      content: "Readable gateway tool output",
    } satisfies Message;
    const latest = {
      id: "latest",
      role: "assistant",
      content: "Latest durable reply",
    } satisfies Message;
    const later = longerStore ? [fresh, latest] : [fresh];
    const snapshot = [initial, toolCall, toolResult];
    const view = mounting(
      async () =>
        stored([
          initial,
          toolCall,
          { ...toolResult, content: { unsupported: "stored result shape" } },
          ...later,
        ]),
      snapshot,
    );
    await view.findByText(fresh.content);
    if (longerStore) expect(view.getByText(latest.content)).toBeTruthy();
    expect(view.getByText(oneHole)).toBeTruthy();
    expect(currentAgent().messages).toEqual([...snapshot, ...later]);
    const user = userEvent.setup({ document: view.container.ownerDocument });
    await user.type(
      view.getByRole("textbox", { name: "Message" }),
      "Continue restored conversation",
    );
    await user.click(view.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(runRequests).toHaveLength(1));
    expect(runRequests[0]?.input.threadId).toBe(channel.threadId);
    expect(runRequests[0]?.input.messages.slice(0, -1)).toEqual([
      ...snapshot,
      ...later,
    ]);
  },
);

test("a stalled mount history read releases the send gate and shows unavailable history", async () => {
  const pending = delayedResponse();
  const view = mounting((_threadId) => pending.promise, [initial]);
  await waitFor(() => expect(historyReads).toHaveLength(1));
  const user = userEvent.setup({ document: view.container.ownerDocument });
  await user.type(
    view.getByRole("textbox", { name: "Message" }),
    "Send while history stalls",
  );
  await user.click(view.getByRole("button", { name: "Send message" }));

  await view.findByText(unavailable, {}, { timeout: 4000 });
  await waitFor(() => expect(runRequests).toHaveLength(1), { timeout: 4000 });
  expect(runRequests[0]?.path).toBe("/api/copilotkit/agent/refresh-bot/run");
  expect(runRequests[0]?.input.threadId).toBe(channel.threadId);
  expect(runRequests[0]?.input.messages.slice(0, -1)).toEqual([initial]);
  expect(runRequests[0]?.input.messages.at(-1)).toMatchObject({
    role: "user",
    content: "Send while history stalls",
  });

  await act(async () => pending.resolve(stored([initial, fresh])));
  expect(view.queryByText(fresh.content)).toBeNull();
  expect(currentAgent().messages.map((message) => message.id)).not.toContain(
    fresh.id,
  );
});

test("a UI send waits for mount history before adding its message", async () => {
  const pending = delayedResponse();
  const view = mounting(() => pending.promise, [initial]);
  await waitFor(() => expect(historyReads).toHaveLength(1));
  const user = userEvent.setup({ document: view.container.ownerDocument });
  await user.type(
    view.getByRole("textbox", { name: "Message" }),
    "Send after restore",
  );
  await user.click(view.getByRole("button", { name: "Send message" }));
  expect(runRequests).toHaveLength(0);
  expect(currentAgent().messages).toEqual([initial]);
  await act(async () => pending.resolve(stored([initial, fresh])));
  await waitFor(() => expect(runRequests).toHaveLength(1));
  expect(runRequests[0]?.input.messages.slice(0, -1)).toEqual([initial, fresh]);
  expect(runRequests[0]?.input.messages.at(-1)).toMatchObject({
    role: "user",
    content: "Send after restore",
  });
});

test("an unmounted history read cannot append messages to its former agent", async () => {
  const pending = delayedResponse();
  const view = mounting(() => pending.promise, [initial]);
  await waitFor(() => expect(historyReads).toHaveLength(1));
  const formerAgent = currentAgent();
  view.unmount();
  await act(async () => pending.resolve(stored([initial, fresh])));
  expect(formerAgent.messages).toEqual([initial]);
});

test("explicit valid-empty durable history finishes without a failure notice", async () => {
  const view = mounting(async () => stored([]));
  await waitFor(() => expect(historyReads).toHaveLength(1));
  await waitFor(() =>
    expect(
      view
        .getByRole("textbox", { name: "Message" })
        .getAttribute("contenteditable"),
    ).toBe("true"),
  );
  expect(view.queryByText(unavailable)).toBeNull();
  expect(currentAgent().messages).toEqual([]);
});

test("headless unreadable-only history updates the notice while preserving local messages", async () => {
  const view = await mounted();
  await act(async () => currentAgent().addMessage(local));
  history = async () => stored([broken]);
  await announce(1);
  await view.findByText(oneHole);
  expect(currentAgent().messages.map((message) => message.id)).toEqual([
    "initial",
    "local",
  ]);
});

test("mixed history, exhausted failure, and recovery update the notice without duplicating messages", async () => {
  const view = await mounted();
  await act(async () => currentAgent().addMessage(local));
  history = async () => stored([initial, fresh, broken]);
  await announce(1);
  await view.findByText("Fresh stored reply");
  await view.findByText(oneHole);
  const beforeFailure = historyReads.length;
  history = async () => new NativeResponse("failed", { status: 500 });
  await announce(2);
  await view.findByText(unavailable, {}, { timeout: 4000 });
  expect(historyReads.length - beforeFailure).toBe(3);
  expect(view.queryByText(oneHole)).toBeNull();
  history = async () => stored([initial, fresh]);
  await announce(3);
  await waitFor(() => expect(view.queryByText(unavailable)).toBeNull());
  expect(view.queryByText(oneHole)).toBeNull();
  expect(currentAgent().messages.map((message) => message.id)).toEqual([
    "initial",
    "local",
    "fresh",
  ]);
}, 10000);

test("a slower refresh cannot replace a newer notice or append obsolete history", async () => {
  const view = await mounted();
  const old = delayedResponse();
  history = () => old.promise;
  await announce(1);
  await waitFor(() => expect(historyReads).toHaveLength(2));
  history = async () => stored([initial, fresh, broken]);
  await announce(2);
  await view.findByText("Fresh stored reply");
  await act(async () =>
    old.resolve(
      stored([
        { id: "obsolete", role: "assistant", content: "Obsolete history" },
      ]),
    ),
  );
  expect(view.getByText(oneHole)).toBeTruthy();
  expect(view.queryByText("Obsolete history")).toBeNull();
});

test("a cancelled channel refresh cannot replace the next channel's notice or messages", async () => {
  const view = await mounted();
  const old = delayedResponse();
  history = () => old.promise;
  await announce(1);
  await waitFor(() => expect(historyReads).toHaveLength(2));
  const next = { ...channel, id: "next-channel", threadId: "next-thread" };
  history = async () => stored([initial, broken]);
  cacheChannel(next);
  view.rerender(tree(next));
  await view.findByText(oneHole);
  await act(async () =>
    old.resolve(
      stored([
        { id: "obsolete", role: "assistant", content: "Wrong channel history" },
      ]),
    ),
  );
  expect(view.getByText(oneHole)).toBeTruthy();
  expect(currentAgent(next).messages.map((message) => message.id)).toEqual([
    "initial",
  ]);
  expect(view.queryByText("Wrong channel history")).toBeNull();
});

test.each(["unavailable", "unreadable", "readable"])(
  "a delayed %s mount read cannot overwrite the notice from a newer Bot refresh",
  async (outcome) => {
    const old = delayedResponse();
    const view = mounting(() => old.promise);
    await waitFor(() => expect(historyReads).toHaveLength(1));
    history = async () => stored([fresh, broken]);
    await announce(1);
    await waitFor(() =>
      expect(currentAgent().messages.map((message) => message.id)).toEqual([
        "fresh",
      ]),
    );
    await act(async () =>
      old.resolve(
        outcome === "unavailable"
          ? new NativeResponse("failed", { status: 500 })
          : outcome === "unreadable"
            ? stored([broken, { ...broken, id: "old-hole" }])
            : stored([
                fresh,
                { id: "obsolete", role: "assistant", content: "Old reply" },
              ]),
      ),
    );
    await view.findByText(oneHole);
    expect(currentAgent().messages.map((message) => message.id)).toEqual([
      "fresh",
    ]);
  },
);

test.each([false, true])(
  "recovery restores durable order after a UI send (known prefix: %s)",
  async (prefixPresent) => {
    const view = mounting(async () =>
      prefixPresent
        ? stored([initial])
        : new NativeResponse("failed", { status: 500 }),
    );
    await view.findByText(prefixPresent ? initial.content : unavailable);
    const user = userEvent.setup({ document: view.container.ownerDocument });
    const editor = view.getByRole("textbox", { name: "Message" });
    await user.type(editor, "Local turn after mount completed");
    await user.click(view.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(runRequests).toHaveLength(1));
    const sent = runRequests[0]?.input.messages.at(-1);
    if (sent?.role !== "user") throw new Error("Missing UI user message");
    history = async () => stored([initial, sent, fresh]);
    await announce(1);
    await view.findByText(fresh.content);
    expect(view.queryByText(unavailable)).toBeNull();
    const transcript = view.container.textContent ?? "";
    expect(transcript.indexOf(initial.content)).toBeLessThan(
      transcript.indexOf("Local turn after mount completed"),
    );
    expect(transcript.indexOf("Local turn after mount completed")).toBeLessThan(
      transcript.indexOf(fresh.content),
    );
    await user.type(editor, "Capture restored ordering");
    await user.click(view.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(runRequests).toHaveLength(2));
    expect(runRequests[1]?.input.threadId).toBe(channel.threadId);
    expect(runRequests[1]?.input.messages.slice(0, 3)).toEqual([
      initial,
      sent,
      fresh,
    ]);
    expect(currentAgent().messages.map((message) => message.id)).toEqual(
      runRequests[1]?.input.messages.map((message) => message.id),
    );
  },
);

test.each(["mount", "refresh"])(
  "%s restores a shorter durable snapshot around local messages without replacing their content",
  async (phase) => {
    const toolCall = {
      id: "tool-call",
      role: "assistant",
      toolCalls: [
        {
          id: "call",
          type: "function",
          function: { name: "inspect", arguments: "{}" },
        },
      ],
    } satisfies Message;
    const toolResult = {
      id: "tool-result",
      role: "tool",
      toolCallId: "call",
      content: "Local tool output",
    } satisfies Message;
    const streaming = {
      id: "streaming",
      role: "assistant",
      content: "Current streamed text",
    } satisfies Message;
    const secondAnchor = {
      id: "second-anchor",
      role: "user",
      content: "Current anchor content",
    } satisfies Message;
    const prefix = {
      id: "prefix",
      role: "assistant",
      content: "Missing durable prefix",
    } satisfies Message;
    const interior = {
      id: "interior",
      role: "assistant",
      content: "Missing durable interior",
    } satisfies Message;
    const snapshot = [
      local,
      initial,
      toolCall,
      toolResult,
      secondAnchor,
      streaming,
    ];
    const durable = [
      prefix,
      { ...initial, content: "Stale opening content" },
      interior,
      { ...secondAnchor, content: "Stale anchor content" },
      fresh,
    ];
    const view = mounting(
      async () => stored(phase === "mount" ? durable : []),
      snapshot,
    );
    if (phase === "refresh") {
      await view.findByText(streaming.content);
      history = async () => stored(durable);
      await announce(1);
    }
    await view.findByText(interior.content);
    expect(currentAgent().messages).toEqual([
      local,
      prefix,
      initial,
      toolCall,
      toolResult,
      interior,
      secondAnchor,
      streaming,
      fresh,
    ]);
    history = async () =>
      stored([prefix, initial, interior, secondAnchor, interior]);
    await announce(2);
    await waitFor(() => expect(historyReads.length).toBeGreaterThanOrEqual(3));
    expect(currentAgent().messages).toEqual([
      local,
      prefix,
      initial,
      toolCall,
      toolResult,
      interior,
      secondAnchor,
      streaming,
      fresh,
    ]);
  },
);

test.each(["mount", "refresh"])(
  "%s without shared IDs keeps local order and appends unique durable messages",
  async (phase) => {
    const view = mounting(
      async () => stored(phase === "mount" ? [fresh, fresh] : []),
      [initial, local],
    );
    if (phase === "refresh") {
      await view.findByText(initial.content);
      history = async () => stored([fresh, fresh]);
      await announce(1);
    }
    await view.findByText(fresh.content);
    expect(currentAgent().messages).toEqual([initial, local, fresh]);
  },
);
