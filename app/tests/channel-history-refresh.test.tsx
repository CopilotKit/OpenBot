import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import type { Message } from "@ag-ui/core";
import { CopilotKitProvider, useCopilotKit } from "@copilotkit/react-core/v2";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { type InfiniteData, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, waitFor } from "@testing-library/react";
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
const NativeResponse = globalThis.Response;
const channel: AgentChannel = {
  id: "refresh-channel",
  name: "Refresh test",
  agentIds: ["refresh-bot"],
  threadId: "refresh-thread",
  active: true,
  lastMessageAt: "2026-09-09T00:00:00.000Z",
};
const initial: Message = {
  id: "initial",
  role: "assistant",
  content: "Stored opening",
};
const fresh: Message = {
  id: "fresh",
  role: "assistant",
  content: "Fresh stored reply",
};
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
    async (input: Parameters<typeof fetch>[0]) => {
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
      if (url.pathname.endsWith("/connect")) return sse([]);
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
function mounting(read: typeof history = async () => stored([initial])) {
  historyReads = [];
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
async function announce(at: number, selected = channel) {
  await act(async () => {
    queryClient.setQueryData<ChannelCache>(channelKeys.list(), (cache) => {
      if (!cache) throw new Error("No mounted channel cache");
      const patched = applyChannelEvent(cache, {
        channelId: selected.id,
        lastMessage: "Bot announced a turn",
        lastMessageAgentId: "refresh-bot",
        lastMessageAt: `2026-09-09T00:00:${String(at).padStart(2, "0")}.000Z`,
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

test("a delayed mount read cannot overwrite the notice from a newer Bot refresh", async () => {
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
    old.resolve(stored([broken, { ...broken, id: "old-hole" }])),
  );
  await view.findByText(oneHole);
  expect(currentAgent().messages.map((message) => message.id)).toEqual([
    "fresh",
  ]);
});
