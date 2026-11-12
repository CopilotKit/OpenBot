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
import { CopilotKitProvider } from "@copilotkit/react-core/v2";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { type InfiniteData, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ChannelChat } from "@/components/channels/channel-chat";
import {
  type AgentChannel,
  type ChannelPage,
  type ChannelSummary,
  channelKeys,
} from "@/lib/channels/queries";
import { queryClient } from "@/query-client";
import { settleReactWork } from "./settle-react-work";

/**
 * Switching away from a conversation the Bot is working in, and straight back.
 *
 * The turn goes on in the chat that sent it, and the chat that comes back joins the thread once, when it opens. A join
 * carries a run only if one is live on the thread at that moment, and right after a message is sent it is not yet: the
 * message is still on its way to the server. Found in the browser: back in the conversation a second after sending, it
 * was empty, the person's message gone, no Bot working and the composer open, until the whole answer appeared at once
 * when the turn was over (on a long task, minutes later). A message typed meanwhile started a second run on the thread.
 *
 * End to end in the app: the real chat and the CopilotKit core, against a runtime that answers as the real one does.
 * A join while a run is live sends the thread so far and then that run's events as they come, until it ends; a join
 * with nothing live sends the thread and ends.
 */

const BOT = "story-bot";
const FIRST = "The fox left her den at dusk.";
const REST = " By morning she was home again.";
const channel: AgentChannel = {
  id: "story-channel",
  name: "Stories",
  agentIds: [BOT],
  threadId: "story-thread",
  active: true,
  lastMessageAt: "2026-11-11T00:00:00.000Z",
};
const NativeResponse = globalThis.Response;
const encoder = new TextEncoder();

let runs: RunAgentInput[] = [];
/** The thread as the runtime has stored it. */
let stored: Message[] = [];
/** Holds the turn's run before it reaches the server, and its end after its first words. */
let reachServer: Promise<void> = Promise.resolve();
let finishAnswer: Promise<void> = Promise.resolve();
/** The run live on the thread: its events so far, and the streams following it. */
let live: {
  events: unknown[];
  followers: Set<ReadableStreamDefaultController<Uint8Array>>;
} | null = null;
let originalFetch: typeof fetch;
let originalSocket: typeof WebSocket;

class QuietSocket {
  static readonly OPEN = 1;
  readyState = 0;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  send() {}
  close() {}
}

const frame = (event: unknown) =>
  encoder.encode(`data: ${JSON.stringify(event)}\n\n`);

function sse(events: unknown[]) {
  return new NativeResponse(events.map((event) => frame(event)).join(""), {
    headers: { "content-type": "text/event-stream" },
  });
}

function streaming(
  start: (controller: ReadableStreamDefaultController<Uint8Array>) => void,
) {
  return new NativeResponse(new ReadableStream<Uint8Array>({ start }), {
    headers: { "content-type": "text/event-stream" },
  });
}

/** One event of the live run, to the browser that started it and to every join following it. */
function emit(
  own: ReadableStreamDefaultController<Uint8Array>,
  event: unknown,
): void {
  live?.events.push(event);
  own.enqueue(frame(event));
  for (const follower of live?.followers ?? []) follower.enqueue(frame(event));
}

/** The runtime's run: it reaches the server, says its first words, and finishes when let. Later runs are short. */
function run(input: RunAgentInput, first: boolean): Response {
  const id = `reply-${input.runId}`;
  const [opening, closing] = first ? [FIRST, REST] : ["Short", " it is."];
  return streaming((own) => {
    void (async () => {
      await reachServer;
      // The runtime stores the person's message as the run starts.
      stored = [...input.messages];
      live = { events: [], followers: new Set() };
      emit(own, {
        type: "RUN_STARTED",
        threadId: input.threadId,
        runId: input.runId,
      });
      emit(own, {
        type: "TEXT_MESSAGE_START",
        messageId: id,
        role: "assistant",
      });
      emit(own, {
        type: "TEXT_MESSAGE_CONTENT",
        messageId: id,
        delta: opening,
      });
      await finishAnswer;
      emit(own, {
        type: "TEXT_MESSAGE_CONTENT",
        messageId: id,
        delta: closing,
      });
      emit(own, { type: "TEXT_MESSAGE_END", messageId: id });
      stored = [
        ...input.messages,
        { id, role: "assistant", content: opening + closing },
      ];
      const followers = live.followers;
      emit(own, {
        type: "RUN_FINISHED",
        threadId: input.threadId,
        runId: input.runId,
      });
      live = null;
      own.close();
      for (const follower of followers) follower.close();
    })();
  });
}

/** A join: the thread so far, then the live run's events as they come until it ends, or nothing more. */
function connect(): Response {
  if (!live)
    return sse([
      { type: "RUN_STARTED", threadId: channel.threadId, runId: "join" },
      { type: "MESSAGES_SNAPSHOT", messages: stored },
      { type: "RUN_FINISHED", threadId: channel.threadId, runId: "join" },
    ]);
  const following = live;
  return streaming((controller) => {
    const [started, ...rest] = following.events;
    controller.enqueue(frame(started));
    controller.enqueue(frame({ type: "MESSAGES_SNAPSHOT", messages: stored }));
    for (const event of rest) controller.enqueue(frame(event));
    following.followers.add(controller);
  });
}

beforeAll(() => {
  GlobalRegistrator.register();
  originalFetch = globalThis.fetch;
  originalSocket = globalThis.WebSocket;
  globalThis.WebSocket = QuietSocket as unknown as typeof WebSocket;
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
      const request = input instanceof Request ? input : new Request(url, init);
      if (url.pathname.endsWith("/info"))
        return NativeResponse.json({
          version: "fixture",
          agents: { [BOT]: { description: "Fixture", capabilities: {} } },
          mode: "sse",
          telemetryDisabled: true,
        });
      if (url.pathname.endsWith("/connect")) return connect();
      if (url.pathname.endsWith("/run")) {
        const body = RunAgentInputSchema.parse(await request.json());
        runs.push(body);
        return run(body, runs.length === 1);
      }
      if (url.pathname.match(/\/threads\/[^/]+\/messages$/))
        return NativeResponse.json({ messages: stored });
      if (url.pathname === "/api/agents")
        return NativeResponse.json({ agents: [] });
      if (url.pathname === `/api/agents/${BOT}`)
        return NativeResponse.json({
          agent: { id: BOT, visibility: "public", canManage: true },
        });
      if (url.pathname === `/api/components/for-agent/${BOT}`)
        return NativeResponse.json({ components: [] });
      if (url.pathname === "/api/admin/enterprise/me")
        return NativeResponse.json({ capabilities: {}, enforced: false });
      if (url.pathname === `/api/plugins/for/${BOT}`)
        return NativeResponse.json({ skills: [], tools: [] });
      if (url.pathname === "/api/voice/sessions")
        return NativeResponse.json({ sessions: [], nextCursor: null });
      if (/\/api\/channels\/[^/]+\/(activity|busy)$/.test(url.pathname))
        return new NativeResponse(null, { status: 204 });
      if (/^\/api\/approvals\/threads\/[^/]+$/.test(url.pathname))
        return NativeResponse.json({ asksEveryStep: false });
      return NativeResponse.json({ error: "Not found" }, { status: 404 });
    },
    { preconnect: () => undefined },
  );
});
beforeEach(() => {
  runs = [];
  stored = [];
  live = null;
  sessionStorage.clear();
  queryClient.clear();
  queryClient.setQueryData<InfiniteData<ChannelPage>>(channelKeys.list(), {
    pages: [
      {
        channels: [
          {
            ...channel,
            summary: null,
            lastMessage: null,
            lastMessageAgentId: null,
            createdAt: channel.lastMessageAt ?? "",
            pinned: false,
            lastReadAt: null,
          } satisfies ChannelSummary,
        ],
        nextCursor: null,
      },
    ],
    pageParams: [""],
  });
});
afterEach(() => cleanup());
afterAll(async () => {
  await settleReactWork();
  globalThis.fetch = originalFetch;
  globalThis.WebSocket = originalSocket;
  GlobalRegistrator.unregister();
});

/** The signed-in app around one place: the conversation, or another one. */
function app(inConversation: boolean) {
  return (
    <QueryClientProvider client={queryClient}>
      <CopilotKitProvider runtimeUrl="http://localhost/api/copilotkit">
        {inConversation ? (
          <ChannelChat channel={channel} runtimeAgentId={BOT} />
        ) : (
          <p>Another conversation</p>
        )}
      </CopilotKitProvider>
    </QueryClientProvider>
  );
}

function gate(): [Promise<void>, () => void] {
  let open = () => {};
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return [promise, open];
}

test("back in a conversation straight after sending, the Bot's answer streams in while it works, and a message typed meanwhile waits for it", async () => {
  const [server, letReachServer] = gate();
  const [end, letFinish] = gate();
  reachServer = server;
  finishAnswer = end;

  const view = render(app(true));
  const user = userEvent.setup({ document: view.container.ownerDocument });
  await user.type(
    await view.findByRole("textbox", { name: "Message" }),
    "Tell me a story about a fox",
  );
  await user.click(view.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(runs).toHaveLength(1), { timeout: 5000 });

  // Away to another conversation and straight back, before the run has reached the server.
  view.rerender(app(false));
  await view.findByText("Another conversation");
  view.rerender(app(true));
  // The conversation reopened has joined the thread, and found nothing running on it yet.
  await view.findByRole("textbox", { name: "Message" });
  await new Promise((resolve) => setTimeout(resolve, 2000));

  // A message typed now waits for the Bot rather than starting a second run on the thread.
  await user.type(
    view.getByRole("textbox", { name: "Message" }),
    "Make it short",
  );
  // Queued, as a message typed while the Bot works always is.
  await user.click(
    view.getByRole("button", { name: /^(Send|Queue) message$/ }),
  );
  await new Promise((resolve) => setTimeout(resolve, 500));
  expect(runs).toHaveLength(1);

  // The run reaches the server: its first words show here while it is still going, the person's message above them.
  letReachServer();
  expect(
    await view.findByText(FIRST, { exact: false }, { timeout: 5000 }),
  ).toBeTruthy();
  expect(view.getByText("Tell me a story about a fox")).toBeTruthy();
  expect(runs).toHaveLength(1);

  // It finishes: the whole answer once, and only then does the message that waited go.
  letFinish();
  expect(
    await view.findByText(FIRST + REST, { exact: false }, { timeout: 5000 }),
  ).toBeTruthy();
  await waitFor(() => expect(runs).toHaveLength(2), { timeout: 5000 });
  expect(runs[1]?.messages.at(-1)).toMatchObject({
    role: "user",
    content: "Make it short",
  });
  expect(view.getAllByText(FIRST + REST, { exact: false })).toHaveLength(1);
}, 30_000);
