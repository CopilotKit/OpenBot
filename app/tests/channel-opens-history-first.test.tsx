import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { AbstractAgent, CopilotKitProvider } from "@copilotkit/react-core/v2";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { type InfiniteData, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";
import { ChannelChat } from "@/components/channels/channel-chat";
import {
  type AgentChannel,
  type ChannelPage,
  type ChannelSummary,
  channelKeys,
} from "@/lib/channels/queries";
import { queryClient } from "@/query-client";
import { MY_CAPABILITIES_PATH } from "./admin-settings-api";
import {
  approvalInboxResponse,
  approvalWriteResponse,
  questionResponsePath,
} from "./approvals-api";
import {
  ASKED_TEXT,
  ASKING_TEXT,
  askPersonReplayEnd,
  askPersonReplayStart,
  askPersonStored,
} from "./ask-person-replay.fixture";
import { botGrantsPath, botGrantsResponse } from "./bot-grants-api";
import { answerBotsList, botPath } from "./bots-api";
import {
  ANSWER_TEXT,
  ANSWERED_EARLY,
  lookupsReplayEnd,
  lookupsReplayStart,
  lookupsStored,
} from "./parallel-lookups.fixture";
import { botComponentsPath, botComponentsResponse } from "./components-api";

/*
 * Opening a conversation shows what it already holds without waiting for the join's replay.
 *
 * The same harness as channel-join-replay.test.tsx: the real provider and ChannelChat, joining a
 * stand-in Intelligence gateway over the Phoenix protocol. Here the gateway is slow, taking 600 ms
 * to send its events, while the stored history answers in 50 ms, and the screen is looked at while
 * the replay is still on its way.
 */

const REPLAY_MS = 600;
const HISTORY_MS = 50;

type ChannelCache = InfiniteData<ChannelPage>;
type Frame = [string | null, string | null, string, string, unknown];
const NativeResponse = globalThis.Response;
const NativeWebSocket = globalThis.WebSocket;
const channel: AgentChannel = {
  id: "join-replay-channel",
  name: "Join replay",
  agentIds: ["join-bot"],
  threadId: "join-replay-thread",
  active: true,
  lastMessageAt: "2026-11-08T00:00:01.000Z",
};
const TOPIC = `thread:${channel.threadId}`;

/**
 * What the gateway does once the browser has joined the thread: send, wait, and say it is idle.
 * Told which join this is, counting from 1 in each test.
 */
type Script = (
  send: (event: string, payload: unknown) => void,
  join: number,
) => Promise<void>;

let originalFetch: typeof fetch;
let gateway: ReturnType<typeof Bun.serve>;
let script: Script = async () => {};
let joins = 0;
let history: () => Response | Promise<Response>;
/** How many times the stored history was read in the current test. */
let historyReads = 0;
/** Whether the gateway has sent `replay_complete` in the current test. */
let replayEnded = false;
/** The questions waiting on the person, as the inbox answers them in the current test. */
let inboxQuestions: unknown[] = [];
/** How many answers to a question were sent in the current test. */
let answersSent = 0;

/** The gateway's replay of `events`, each with the durable id the gateway stamps on it. */
function sending(
  send: (event: string, payload: unknown) => void,
  events: unknown[],
  from = 0,
) {
  for (const [index, event] of events.entries()) {
    send("ag_ui_event", {
      ...(event as Record<string, unknown>),
      metadata: { cpki_event_id: `event-${from + index}` },
    });
  }
}

beforeAll(() => {
  gateway = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, server) {
      return server.upgrade(request, { data: undefined })
        ? undefined
        : new NativeResponse("upgrade failed", { status: 400 });
    },
    websocket: {
      message(socket, message) {
        const [joinRef, ref, topic, event] = JSON.parse(
          String(message),
        ) as Frame;
        const send = (name: string, payload: unknown) => {
          if (socket.readyState === 1)
            socket.send(JSON.stringify([joinRef, null, TOPIC, name, payload]));
        };
        socket.send(
          JSON.stringify([
            joinRef,
            ref,
            topic,
            "phx_reply",
            { status: "ok", response: {} },
          ]),
        );
        if (event === "phx_join" && topic === TOPIC) {
          joins += 1;
          void script(send, joins);
        }
      },
    },
  });
  GlobalRegistrator.register({ url: "http://localhost/" });
  // Phoenix opens a real socket to the stand-in gateway.
  globalThis.WebSocket = NativeWebSocket;
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
      const bots = answerBotsList(url, init, { visible: [] });
      if (bots) return bots;
      if (url.pathname === botGrantsPath("join-bot"))
        return botGrantsResponse();
      if (url.pathname === botPath("join-bot"))
        return NativeResponse.json({
          bot: { id: "join-bot", visibility: "public", canManage: true },
        });
      if (url.pathname === botComponentsPath("join-bot"))
        return botComponentsResponse();
      if (url.pathname === MY_CAPABILITIES_PATH)
        return NativeResponse.json({ capabilities: {}, enforced: false });
      {
        const inbox = {
          enabled: true,
          requests: [],
          rules: [],
          teamRules: [],
          questions: inboxQuestions,
        };
        if (url.pathname === questionResponsePath("apple-question"))
          answersSent += 1;
        const written = approvalWriteResponse(url.pathname, init, inbox);
        if (written) return written;
        const approvals = approvalInboxResponse(url.pathname, inbox);
        if (approvals) return approvals;
      }
      if (url.pathname.endsWith("/info"))
        return NativeResponse.json({
          version: "fixture",
          agents: { "join-bot": { description: "Fixture", capabilities: {} } },
          mode: "intelligence",
          intelligence: { wsUrl: `ws://127.0.0.1:${gateway.port}/client` },
          telemetryDisabled: true,
        });
      // Whether the conversation still has a run going is asked with the API's join token.
      const joinTokenAsked = /\/conversations\/[^/]+\/join-tokens$/.test(
        url.pathname,
      );
      if (joinTokenAsked)
        return NativeResponse.json(
          {
            joinToken: "join-token",
            expiresAt: new Date(Date.now() + 30_000).toISOString(),
            threadId: channel.threadId,
            runId: null,
            realtime: {
              clientUrl: `ws://127.0.0.1:${gateway.port}/client`,
              topic: TOPIC,
            },
          },
          { status: 201 },
        );
      if (url.pathname.endsWith("/agent/join-bot/connect"))
        return NativeResponse.json({
          threadId: channel.threadId,
          runId: null,
          joinToken: "join-token",
          realtime: {
            clientUrl: `ws://127.0.0.1:${gateway.port}/client`,
            topic: TOPIC,
          },
        });
      if (
        /^\/api\/v2\/organizations\/default\/conversations\/[^/]+\/(activity|signal-busy)$/.test(
          url.pathname,
        )
      )
        return new NativeResponse(null, { status: 204 });
      if (
        /^\/api\/v2\/organizations\/default\/conversations\/[^/]+\/voice-sessions$/.test(
          url.pathname,
        )
      )
        return NativeResponse.json({ sessions: [], nextCursor: null });
      if (/\/threads\/[^/]+\/messages$/.test(url.pathname)) {
        historyReads += 1;
        return history();
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
  historyReads = 0;
  replayEnded = false;
  joins = 0;
  inboxQuestions = [];
  answersSent = 0;
});
afterAll(() => {
  globalThis.fetch = originalFetch;
  GlobalRegistrator.unregister();
  gateway.stop(true);
});

/** The roster, holding this conversation, busy when the Bot is working in it. */
function roster(busy = false) {
  const summary: ChannelSummary = {
    ...channel,
    summary: null,
    lastMessage: "Planning the cycle",
    lastMessageAgentId: "join-bot",
    lastMessageAt: "2026-11-08T00:00:01.000Z",
    createdAt: "2026-11-08T00:00:00.000Z",
    pinned: false,
    lastReadAt: null,
    ...(busy ? { busy: true } : {}),
  };
  queryClient.setQueryData<ChannelCache>(channelKeys.list(), {
    pages: [{ channels: [summary], nextCursor: null }],
    pageParams: [""],
  });
}

function opened() {
  return render(
    <QueryClientProvider client={queryClient}>
      <CopilotKitProvider runtimeUrl="http://localhost/api/copilotkit">
        <ChannelChat channel={channel} runtimeAgentId="join-bot" />
      </CopilotKitProvider>
    </QueryClientProvider>,
  );
}

/** How many times `text` is on screen. */
function shown(container: HTMLElement, text: string): number {
  return (container.textContent ?? "").split(text).length - 1;
}

const sleep = (milliseconds: number) =>
  act(() => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));

/** The gateway sends `events` after its slow start, says the replay is over, and then that it is idle. */
function replaying(events: unknown[]): Script {
  return async (send) => {
    await new Promise((resolve) => setTimeout(resolve, REPLAY_MS));
    sending(send, events);
    send("replay_complete", { latestEventId: `event-${events.length - 1}` });
    replayEnded = true;
    send("stream_idle", { latestEventId: `event-${events.length - 1}` });
  };
}

/** The store answers with `messages`, 50 ms after it is asked. */
function storing(messages: () => unknown[]) {
  history = async () => {
    await new Promise((resolve) => setTimeout(resolve, HISTORY_MS));
    return NativeResponse.json({ messages: messages() });
  };
}

const PLAIN_USER = "How is the cycle going?";
const PLAIN_REPLY = "The cycle is on track and nothing is blocked.";
const PLAIN_MESSAGE = "plain-reply-message";

function plainStored(): unknown[] {
  return [
    { id: "plain-user", role: "user", content: PLAIN_USER },
    { id: PLAIN_MESSAGE, role: "assistant", content: PLAIN_REPLY },
  ];
}

function plainReplay(): unknown[] {
  const event = (fields: Record<string, unknown>) => ({
    ...fields,
    threadId: channel.threadId,
    runId: "plain-run",
  });
  return [
    event({ type: "RUN_STARTED" }),
    event({
      type: "TEXT_MESSAGE_START",
      messageId: PLAIN_MESSAGE,
      role: "assistant",
    }),
    event({
      type: "TEXT_MESSAGE_CONTENT",
      messageId: PLAIN_MESSAGE,
      delta: PLAIN_REPLY,
    }),
    event({ type: "TEXT_MESSAGE_END", messageId: PLAIN_MESSAGE }),
    event({ type: "RUN_FINISHED" }),
  ];
}

const ASK_USER =
  "Ask me with your question tool which colour of apple I prefer, red or green, then wait for my answer.";
const LOOKUPS_USER =
  "Read the current cycle and its planning pages, match them up and rank the triage list.";

const turns = [
  {
    name: "a plain reply",
    user: PLAIN_USER,
    replies: [PLAIN_REPLY],
    stored: plainStored,
    replay: plainReplay,
  },
  {
    name: "a question put to the person",
    user: ASK_USER,
    replies: [ASKING_TEXT, ASKED_TEXT],
    stored: () => askPersonStored("asked"),
    replay: () => [
      ...askPersonReplayStart(channel.threadId),
      ...askPersonReplayEnd(channel.threadId),
    ],
  },
  {
    name: "twenty parallel lookups",
    user: LOOKUPS_USER,
    replies: [ANSWER_TEXT],
    stored: () => lookupsStored("asked"),
    replay: () => [
      ...lookupsReplayStart(channel.threadId),
      ...lookupsReplayEnd(channel.threadId),
    ],
  },
];

test("the stored messages are on screen before the replay ends", async () => {
  const turn = turns[0];
  if (!turn) throw new Error("No turn");
  script = replaying(turn.replay());
  storing(turn.stored);
  roster();

  const view = opened();
  await sleep(200);

  expect(replayEnded).toBe(false);
  expect(shown(view.container, turn.user)).toBe(1);
  for (const reply of turn.replies)
    expect(shown(view.container, reply)).toBe(1);
  expect(historyReads).toBeGreaterThan(0);
});

for (const turn of turns) {
  test(`nothing shows twice once the replay ends: ${turn.name}`, async () => {
    script = replaying(turn.replay());
    storing(turn.stored);
    roster();

    const view = opened();
    await waitFor(() => expect(replayEnded).toBe(true), { timeout: 4000 });
    await sleep(500);

    expect(shown(view.container, turn.user)).toBe(1);
    for (const reply of turn.replies)
      expect(shown(view.container, reply)).toBe(1);
    expect(historyReads).toBeGreaterThan(0);
  }, 10_000);
}

test("a turn still running streams in live", async () => {
  const LIVE_TEXT = "Matching the lookups against the cycle now";
  const start = lookupsReplayStart(channel.threadId);
  script = async (send) => {
    await new Promise((resolve) => setTimeout(resolve, REPLAY_MS));
    sending(send, start);
    send("replay_complete", { latestEventId: `event-${start.length - 1}` });
    replayEnded = true;
    // The run is still going: its next words come live, and the thread never says it is idle.
    const live = (fields: Record<string, unknown>) => ({
      ...fields,
      threadId: channel.threadId,
      runId: (start[0] as { runId: string }).runId,
    });
    sending(
      send,
      [
        live({
          type: "TEXT_MESSAGE_START",
          messageId: "live-message",
          role: "assistant",
        }),
        live({
          type: "TEXT_MESSAGE_CONTENT",
          messageId: "live-message",
          delta: LIVE_TEXT,
        }),
      ],
      start.length,
    );
  };
  storing(() => lookupsStored("asked", ANSWERED_EARLY));
  roster(true);

  const view = opened();
  await view.findByText(LIVE_TEXT, undefined, { timeout: 4000 });

  expect(view.container.querySelector('[aria-busy="true"]')).not.toBeNull();
  expect(view.getByRole("button", { name: "Stop the Bot" })).not.toBeNull();
  expect(shown(view.container, LIVE_TEXT)).toBe(1);
}, 10_000);

test("a turn that ended just before opening is kept", async () => {
  const turn = turns[1];
  if (!turn) throw new Error("No turn");
  // The first read comes before the Bot's last reply is stored; the replay and later reads have it.
  let reads = 0;
  storing(() => {
    reads += 1;
    const whole = turn.stored();
    return reads === 1 ? whole.slice(0, -1) : whole;
  });
  script = replaying(turn.replay());
  roster();

  const view = opened();
  await waitFor(() => expect(replayEnded).toBe(true), { timeout: 4000 });
  await sleep(500);

  expect(shown(view.container, ASKED_TEXT)).toBe(1);
  expect(shown(view.container, ASKING_TEXT)).toBe(1);
  expect(historyReads).toBeGreaterThan(0);
}, 10_000);

test("a stored history that can't be read says so as today", async () => {
  script = replaying([]);
  history = async () => {
    await new Promise((resolve) => setTimeout(resolve, HISTORY_MS));
    return NativeResponse.json({ error: "unavailable" }, { status: 503 });
  };
  roster();

  const view = opened();
  await sleep(200);
  expect(shown(view.container, PLAIN_USER)).toBe(0);
  expect(view.queryByText(/Couldn't load earlier messages\./)).toBeNull();

  // Said once the read on opening and the retries after it have run out of time.
  await view.findByText(/Couldn't load earlier messages\./, undefined, {
    timeout: 20_000,
  });
  expect(shown(view.container, PLAIN_USER)).toBe(0);
  expect(historyReads).toBeGreaterThan(1);
}, 30_000);

/*
 * The stored copy is drawn while the join replays onto an agent it emptied, and the replay appends
 * its text to anything set on the agent meanwhile. So nothing drawn then may change the agent: the
 * question the Bot is waiting on can't be answered until the join is over, and then it can.
 */
test("nothing in the early history can be pressed while the replay runs", async () => {
  const turn = turns[1];
  if (!turn) throw new Error("No turn");
  inboxQuestions = [
    {
      id: "apple-question",
      botId: "join-bot",
      threadId: channel.threadId,
      channelId: channel.id,
      question: "Which colour of apple do you prefer, red or green?",
      parts: [
        {
          header: "Apple colour",
          question: "Which colour of apple do you prefer?",
          options: ["Red", "Green"],
        },
      ],
    },
  ];
  script = replaying(turn.replay());
  storing(turn.stored);
  roster();

  /*
   * Every `setMessages` this app makes on an agent, and whether the replay was over when it did:
   * the SDK's own (emptying the agent as the join starts, copying what the join brings) are left
   * out, as they are the replay itself. Told apart by the call's immediate caller. Every agent
   * class the SDK has takes `setMessages` from `AbstractAgent`.
   */
  const setByApp: { replayOver: boolean }[] = [];
  const agents = AbstractAgent.prototype;
  const original = agents.setMessages;
  agents.setMessages = function (this: AbstractAgent, messages) {
    const caller = new Error().stack?.split("\n")[2] ?? "";
    if (caller.includes("/app/src/"))
      setByApp.push({ replayOver: replayEnded });
    return original.call(this, messages);
  };

  try {
    const view = opened();
    await sleep(200);

    // The stored copy is on screen, the replay is not over, and the question can't be answered.
    expect(replayEnded).toBe(false);
    expect(shown(view.container, ASKED_TEXT)).toBe(1);
    const send = await view.findByRole("button", { name: "Send answer" });
    expect((send as HTMLButtonElement).disabled).toBe(true);

    // Pressed anyway, and sent by its form: neither reaches the server or the agent.
    fireEvent.click(view.getByRole("radio", { name: /Red/ }));
    fireEvent.click(send);
    const form = send.closest("form");
    if (!form) throw new Error("No form");
    fireEvent.submit(form);
    await sleep(100);
    expect(answersSent).toBe(0);

    await waitFor(() => expect(replayEnded).toBe(true), { timeout: 4000 });
    await waitFor(
      () =>
        expect(
          (
            view.getByRole("button", {
              name: "Send answer",
            }) as HTMLButtonElement
          ).disabled,
        ).toBe(false),
      { timeout: 4000 },
    );
    expect(answersSent).toBe(0);
    expect(setByApp.filter((call) => !call.replayOver)).toEqual([]);
  } finally {
    agents.setMessages = original;
  }
}, 10_000);
