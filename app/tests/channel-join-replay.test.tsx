import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { CopilotKitProvider, useCopilotKit } from "@copilotkit/react-core/v2";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { type InfiniteData, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { useEffect } from "react";
import { ChannelChat } from "@/components/channels/channel-chat";
import { Route as ChannelRoute } from "@/routes/_authed/_app/channel/$channelId";
import {
  type AgentChannel,
  type ChannelPage,
  type ChannelSummary,
  channelKeys,
} from "@/lib/channels/queries";
import { applyChannelEvent } from "@/lib/channels/use-channel-events";
import { queryClient } from "@/query-client";
import {
  ASKED_SO_FAR,
  ASKED_TEXT,
  ASKING_TEXT,
  askPersonReplayEnd,
  askPersonReplayStart,
  askPersonStored,
} from "./ask-person-replay.fixture";
import {
  ANSWER_TEXT,
  ANSWERED_EARLY,
  answerOf,
  LOOKUPS,
  lookupsReplayEnd,
  lookupsReplayStart,
  lookupsStored,
} from "./parallel-lookups.fixture";

/*
 * Opening a conversation joins its thread, and the join replays the thread onto the screen. A Bot's
 * reply must come out of that once, and whole.
 *
 * The real provider, ChannelChat, its history reader and the AG-UI reducer, joining through the
 * Intelligence gateway's realtime protocol as OpenBot does in every edition: a REST `/connect` for
 * credentials, then a Phoenix channel that sends the thread's events, `replay_complete`, and
 * `stream_idle` once no turn is running. Only that gateway and the HTTP boundary are stand-ins, and
 * what the gateway sends is a real captured turn (see the fixture).
 */

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
let history: () => Response;
let historyReads = 0;
let core: ReturnType<typeof useCopilotKit>["copilotkit"] | undefined;

function CoreProbe() {
  core = useCopilotKit().copilotkit;
  return null;
}

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
      if (url.pathname === "/api/plugins/for/join-bot")
        return NativeResponse.json({ skills: [], tools: [] });
      if (url.pathname === "/api/agents/join-bot")
        return NativeResponse.json({
          agent: { id: "join-bot", visibility: "public", canManage: true },
        });
      if (url.pathname === "/api/components/for-agent/join-bot")
        return NativeResponse.json({ components: [] });
      if (url.pathname === "/api/admin/enterprise/me")
        return NativeResponse.json({ capabilities: {}, enforced: false });
      if (url.pathname === "/api/approvals")
        return NativeResponse.json({
          enabled: true,
          requests: [],
          rules: [],
          teamRules: [],
          questions: [],
        });
      if (url.pathname.endsWith("/info"))
        return NativeResponse.json({
          version: "fixture",
          agents: { "join-bot": { description: "Fixture", capabilities: {} } },
          mode: "intelligence",
          intelligence: { wsUrl: `ws://127.0.0.1:${gateway.port}/client` },
          telemetryDisabled: true,
        });
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
      if (/\/api\/channels\/[^/]+\/(activity|busy)$/.test(url.pathname))
        return new NativeResponse(null, { status: 204 });
      if (url.pathname === "/api/voice/sessions")
        return NativeResponse.json({ sessions: [], nextCursor: null });
      if (/\/threads\/[^/]+\/messages$/.test(url.pathname)) {
        historyReads += 1;
        return history();
      }
      // The conversation's own page, for the test that goes through the router.
      if (url.pathname === `/api/channels/${channel.id}`)
        return NativeResponse.json({ channel });
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
  joins = 0;
  joinHeld = null;
});
afterAll(() => {
  globalThis.fetch = originalFetch;
  GlobalRegistrator.unregister();
  gateway.stop(true);
});

/** The roster, holding this conversation with the Bot's latest activity in it. */
function roster(at: string, text: string) {
  const summary: ChannelSummary = {
    ...channel,
    summary: null,
    lastMessage: text,
    lastMessageAgentId: "join-bot",
    lastMessageAt: at,
    createdAt: "2026-11-08T00:00:00.000Z",
    pinned: false,
    lastReadAt: null,
  };
  queryClient.setQueryData<ChannelCache>(channelKeys.list(), {
    pages: [{ channels: [summary], nextCursor: null }],
    pageParams: [""],
  });
}

/** The roster hears of a new turn by the Bot, as its socket patches the list. */
async function announce(at: string, text: string) {
  await act(async () => {
    queryClient.setQueryData<ChannelCache>(channelKeys.list(), (cache) => {
      if (!cache) throw new Error("No channel cache");
      const patched = applyChannelEvent(cache, {
        channelId: channel.id,
        lastMessage: text,
        lastMessageAgentId: "join-bot",
        lastMessageAt: at,
      });
      if (patched === "unknown") throw new Error("Channel missing from cache");
      return patched;
    });
  });
}

/**
 * Where the join is held: after it has emptied the transcript to rebuild it and before its replay
 * starts. That span is the gateway's client being set up, and a history read can land in it; here
 * CopilotKit's own "a run is starting" notice, which the join awaits in that span, holds it open.
 */
let joinHeld: Promise<void> | null = null;
let joinReached: () => void = () => {};

function HoldJoin() {
  const { copilotkit } = useCopilotKit();
  useEffect(() => {
    const subscription = copilotkit.subscribe({
      onAgentRunStarted: async () => {
        if (!joinHeld) return;
        joinReached();
        await joinHeld;
      },
    });
    return () => subscription.unsubscribe();
  }, [copilotkit]);
  return null;
}

function opened() {
  return render(
    <QueryClientProvider client={queryClient}>
      <CopilotKitProvider runtimeUrl="http://localhost/api/copilotkit">
        <CoreProbe />
        <HoldJoin />
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

test("a reply is shown once when the roster announces its turn while the conversation is joining", async () => {
  let release: () => void = () => {};
  joinHeld = new Promise((resolve) => {
    release = resolve;
  });
  const reached = new Promise<void>((resolve) => {
    joinReached = resolve;
  });
  // The turn is over: the gateway replays it whole and says the thread is idle.
  const turn = [
    ...askPersonReplayStart(channel.threadId),
    ...askPersonReplayEnd(channel.threadId),
  ];
  script = async (send) => {
    sending(send, turn);
    send("replay_complete", { latestEventId: `event-${turn.length - 1}` });
    send("stream_idle", { latestEventId: `event-${turn.length - 1}` });
  };
  // And the store holds it whole.
  history = () => NativeResponse.json({ messages: askPersonStored("asked") });
  roster("2026-11-08T00:00:01.000Z", "Ask me which colour of apple");

  const view = opened();
  await act(() => reached);
  // The Bot's question lands in the roster while the conversation is still joining its thread.
  await announce(
    "2026-11-08T00:00:02.000Z",
    "A question needs your answer: Which colour of apple do you prefer?",
  );
  await sleep(300);
  joinHeld = null;
  await act(async () => release());

  await waitFor(
    () => expect(shown(view.container, ASKED_TEXT)).toBeGreaterThanOrEqual(1),
    { timeout: 4000 },
  );
  await sleep(300);
  // What the Bot said, as the conversation holds it and as the screen draws it: each reply once.
  expect(
    core
      ?.getAgent(`channel:${channel.id}`)
      ?.messages.filter((message) => message.role === "assistant")
      .map((message) => message.content),
  ).toEqual([ASKING_TEXT, ASKED_TEXT]);
  expect(shown(view.container, ASKING_TEXT)).toBe(1);
  expect(shown(view.container, ASKED_TEXT)).toBe(1);
  expect(historyReads).toBeGreaterThan(0);
});

test("a reply still being written when the conversation is opened arrives whole", async () => {
  // The gateway replays the turn so far, then carries the rest of the reply live as the Bot writes
  // it, later than the join's deadline, and says the thread is idle once the turn is over.
  const start = askPersonReplayStart(channel.threadId);
  const end = askPersonReplayEnd(channel.threadId);
  script = async (send) => {
    sending(send, start);
    send("replay_complete", { latestEventId: `event-${start.length - 1}` });
    await new Promise((resolve) => setTimeout(resolve, 2500));
    sending(send, end, start.length);
    send("stream_idle", {
      latestEventId: `event-${start.length + end.length - 1}`,
    });
  };
  // The store, read meanwhile, holds the reply as far as it has got.
  history = () =>
    NativeResponse.json({ messages: askPersonStored("asked", ASKED_SO_FAR) });
  roster("2026-11-08T00:00:01.000Z", "Ask me which colour of apple");

  const view = opened();
  await view.findByText(ASKED_SO_FAR, undefined, { timeout: 4000 });
  await view.findByText(ASKED_TEXT, undefined, { timeout: 6000 });
  expect(shown(view.container, ASKING_TEXT)).toBe(1);
  expect(shown(view.container, ASKED_TEXT)).toBe(1);
}, 15_000);

/*
 * The conversation's real route, under the app's layout ids, beside a home page to leave it for.
 * TanStack's generated tree wires a file route with update({ id, path, getParentRoute })
 * (app/src/routeTree.gen.ts); the update type tests see leaves those fields out, hence the cast.
 */
const rootRoute = createRootRoute({ component: Outlet });
const authedRoute = createRoute({
  id: "/_authed",
  getParentRoute: () => rootRoute,
  component: Outlet,
});
const appRoute = createRoute({
  id: "/_app",
  getParentRoute: () => authedRoute,
  component: Outlet,
});
const homeRoute = createRoute({
  path: "/",
  getParentRoute: () => appRoute,
  component: () => <p>Home page</p>,
});
const conversationRoute = ChannelRoute.update({
  id: "/channel/$channelId",
  path: "/channel/$channelId",
  getParentRoute: () => appRoute,
} as Parameters<typeof ChannelRoute.update>[0] & {
  id: string;
  path: string;
  getParentRoute: () => typeof appRoute;
});

test("a reply is shown once and whole after leaving its conversation and coming back while the Bot answers", async () => {
  const start = askPersonReplayStart(channel.threadId);
  const end = askPersonReplayEnd(channel.threadId);
  script = async (send, join) => {
    // Each join replays the turn so far. The first is left while the Bot is still answering; the
    // second carries the rest of the reply, later than the join's deadline.
    sending(send, start);
    send("replay_complete", { latestEventId: `event-${start.length - 1}` });
    if (join === 1) return;
    await new Promise((resolve) => setTimeout(resolve, 2500));
    sending(send, end, start.length);
    send("stream_idle", {
      latestEventId: `event-${start.length + end.length - 1}`,
    });
  };
  // The store, read meanwhile, holds the reply as far as it has got.
  history = () =>
    NativeResponse.json({ messages: askPersonStored("asked", ASKED_SO_FAR) });
  roster("2026-11-08T00:00:01.000Z", "Ask me which colour of apple");
  queryClient.setQueryData(channelKeys.detail(channel.id), channel);

  const router = createRouter({
    routeTree: rootRoute.addChildren([
      authedRoute.addChildren([
        appRoute.addChildren([homeRoute, conversationRoute]),
      ]),
    ]),
    history: createMemoryHistory({
      initialEntries: [`/channel/${channel.id}`],
    }),
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <CopilotKitProvider runtimeUrl="http://localhost/api/copilotkit">
        <CoreProbe />
        <HoldJoin />
        <RouterProvider router={router as never} />
      </CopilotKitProvider>
    </QueryClientProvider>,
  );
  await view.findByText(ASKED_SO_FAR, undefined, { timeout: 4000 });

  // The person goes elsewhere in the app while the Bot is still answering, and comes back.
  await act(() => router.navigate({ to: "/" }));
  await view.findByText("Home page");
  let release: () => void = () => {};
  joinHeld = new Promise((resolve) => {
    release = resolve;
  });
  const reached = new Promise<void>((resolve) => {
    joinReached = resolve;
  });
  await act(async () => router.history.back());
  await act(() => reached);
  // The Bot's question lands in the roster while the conversation is joining again.
  await announce(
    "2026-11-08T00:00:02.000Z",
    "A question needs your answer: Which colour of apple do you prefer?",
  );
  await sleep(300);
  joinHeld = null;
  await act(async () => release());

  await waitFor(
    () => expect(shown(view.container, ASKED_TEXT)).toBeGreaterThanOrEqual(1),
    { timeout: 6000 },
  );
  await sleep(300);
  expect(
    core
      ?.getAgent(`channel:${channel.id}`)
      ?.messages.filter((message) => message.role === "assistant")
      .map((message) => message.content),
  ).toEqual([ASKING_TEXT, ASKED_TEXT]);
  expect(shown(view.container, ASKING_TEXT)).toBe(1);
  expect(shown(view.container, ASKED_TEXT)).toBe(1);
}, 20_000);

test("the answers a step was still waiting on reach a conversation opened part way through it", async () => {
  // 20 lookups sent in one step, 11 answered and 9 still running. The gateway replays that later
  // than the join's deadline, as a busy one does, then carries the 9 answers and the Bot's reply
  // live, and says the thread is idle once the turn is over.
  const start = lookupsReplayStart(channel.threadId);
  const end = lookupsReplayEnd(channel.threadId);
  script = async (send) => {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    sending(send, start);
    send("replay_complete", { latestEventId: `event-${start.length - 1}` });
    await new Promise((resolve) => setTimeout(resolve, 500));
    sending(send, end, start.length);
    send("stream_idle", {
      latestEventId: `event-${start.length + end.length - 1}`,
    });
  };
  // The store, read on opening, holds the answers that were in by then.
  history = () =>
    NativeResponse.json({ messages: lookupsStored("asked", ANSWERED_EARLY) });
  // And the roster says the Bot is working in this conversation.
  roster("2026-11-08T00:00:01.000Z", "Planning the cycle");
  queryClient.setQueryData<ChannelCache>(channelKeys.list(), (cache) =>
    cache
      ? {
          ...cache,
          pages: cache.pages.map((page) => ({
            ...page,
            channels: page.channels.map((row) => ({ ...row, busy: true })),
          })),
        }
      : cache,
  );

  const view = opened();
  await view.findByText(ANSWER_TEXT, undefined, { timeout: 6000 });
  // Every lookup has its own answer in the conversation, none of them made up.
  const answers = new Map(
    (core?.getAgent(`channel:${channel.id}`)?.messages ?? []).flatMap(
      (message) =>
        message.role === "tool"
          ? [[message.toolCallId, String(message.content)] as const]
          : [],
    ),
  );
  expect(LOOKUPS.map((lookup) => answers.get(lookup.id))).toEqual(
    LOOKUPS.map((_, index) => answerOf(index)),
  );
}, 15_000);
