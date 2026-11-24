import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import type { Message, RunAgentInput } from "@ag-ui/core";
import { RunAgentInputSchema } from "@ag-ui/core/schemas";
import { CopilotKitProvider, useFrontendTool } from "@copilotkit/react-core/v2";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { type InfiniteData, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ChannelChat } from "@/components/channels/channel-chat";
import {
  type AgentChannel,
  type ChannelPage,
  channelKeys,
  type RefusedTurn,
} from "@/lib/channels/queries";
import { quietRunPeriod, RUN_ENDED_UNHEARD } from "@/lib/copilot/quiet-run";
import { TURN_CUT_OFF } from "@/lib/copilot/stopped-turn";
import { queryClient } from "@/query-client";
import { MY_CAPABILITIES_PATH } from "./admin-settings-api";
import { botGrantsPath, botGrantsResponse } from "./bot-grants-api";
import { answerBotsList, botPath } from "./bots-api";
import { botComponentsPath, botComponentsResponse } from "./components-api";

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
  /** The Bot works (it says what it found, and reads an app) and then the run fails. */
  | { kind: "worksThenFails"; text: string; message: string }
  | { kind: "calls"; tool: string }
  | { kind: "answers"; text: string }
  | { kind: "stalls"; text: string }
  /** The runtime refuses the run for a Bot that is not this person's, as it does: 404, agent not found. */
  | { kind: "refused" }
  /**
   * OpenBot's server refuses the run for the person, with its own problem and a sentence for them,
   * as it does for a model their teams don't allow (403, MODEL_NOT_ALLOWED).
   */
  | { kind: "forbidden"; detail: string }
  /** The back end answers the run request with a server error. */
  | { kind: "breaks" }
  /** The run request never reaches a back end at all. */
  | { kind: "unreachable" }
  /** The run request is taken and nothing of it ever comes back: its server died under it. */
  | { kind: "silent" };

let originalFetch: typeof fetch;
let plans: RunPlan[] = [];
/** Every event the runtime has streamed for a thread, run after run: what `/connect` replays. */
let recorded = new Map<string, unknown[]>();
/** The thread's stored messages: what was said, and nothing about how a run ended. */
let stored = new Map<string, Message[]>();
let stopRequests: string[] = [];
/** The turns the server refused, as it keeps them: what `listRefusedTurns` answers, oldest first. */
let refusedTurns: RefusedTurn[] = [];
/**
 * How the API answers a read of the Bot once a run has been asked for: it is this person's, it is not
 * (404), or the server broke. Before that it is found, as it was for a person already talking to the
 * Bot: what each test is about is the read after the run went wrong. A read that fails before the
 * run is asked for is waited out with the screen's own retry, a second later (`factsFor` in
 * lib/copilot/bot-offer.ts), and that second is not what these tests are about.
 */
let botRead: "found" | "not-found" | "breaks" = "found";
/** Whether a run has been asked for since the test began, from when `botRead` applies. */
let runAsked = false;
let botReads = 0;
/**
 * How runs travel, as the runtime's `/info` says. Through Intelligence, a run is a request for join
 * credentials and then a socket; a request that is refused never gets as far as the socket, which is
 * all the tests in that mode need, and joining a thread with nothing to replay answers 204.
 */
let transport: "sse" | "intelligence" = "sse";
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
  // The runtime's own answer for an agent that is not among the caller's (`cloneAgentForRequest`).
  if (plan.kind === "refused")
    return NativeResponse.json(
      {
        error: "Agent not found",
        message: "Agent 'failed-run-bot' does not exist",
      },
      { status: 404 },
    );
  if (plan.kind === "forbidden") {
    /*
     * The server keeps the turn it refused (`listRefusedTurns`): the person's message, the thread
     * message it came after as this app sent it, and the sentence. Nothing reaches the thread.
     */
    const asked = input.messages.at(-1);
    const before = input.messages.at(-2);
    refusedTurns.push({
      id: `refused-${refusedTurns.length + 1}`,
      botId: "failed-run-bot",
      threadId: input.threadId,
      afterMessageId: before?.id ?? null,
      message:
        asked?.role === "user"
          ? {
              id: asked.id,
              text: typeof asked.content === "string" ? asked.content : "",
            }
          : null,
      initiator: "person",
      code: "MODEL_NOT_ALLOWED",
      detail: plan.detail,
      model: "openai/gpt-4.1",
      createdAt: new Date(Date.now() + refusedTurns.length).toISOString(),
    });
    return NativeResponse.json(
      {
        type: "https://open.bot/errors/model-not-allowed",
        title: "That model isn't allowed.",
        status: 403,
        detail: plan.detail,
        code: "MODEL_NOT_ALLOWED",
        category: "permission",
        retryable: false,
        error: plan.detail,
      },
      {
        status: 403,
        headers: { "content-type": "application/problem+json" },
      },
    );
  }
  if (plan.kind === "breaks")
    return NativeResponse.json({ error: "Bad gateway" }, { status: 502 });
  if (plan.kind === "unreachable") throw new TypeError("Failed to fetch");
  if (plan.kind === "silent")
    return new NativeResponse(new ReadableStream<Uint8Array>(), {
      headers: { "content-type": "text/event-stream" },
    });
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
  if (plan.kind === "worksThenFails") {
    const said = `said-${input.runId}`;
    const read = `read-${input.runId}`;
    const events = [
      started,
      { type: "TEXT_MESSAGE_START", messageId: said, role: "assistant" },
      { type: "TEXT_MESSAGE_CONTENT", messageId: said, delta: plan.text },
      { type: "TEXT_MESSAGE_END", messageId: said },
      {
        type: "TOOL_CALL_START",
        toolCallId: read,
        toolCallName: "mcp__composio-hubspot__HUBSPOT_SEARCH_DEALS",
        parentMessageId: said,
      },
      { type: "TOOL_CALL_ARGS", toolCallId: read, delta: "{}" },
      { type: "TOOL_CALL_END", toolCallId: read },
      {
        type: "TOOL_CALL_RESULT",
        messageId: `result-${input.runId}`,
        toolCallId: read,
        content: '{"deals":2}',
      },
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
      const bots = answerBotsList(url, init, { visible: [] });
      if (bots) return bots;
      if (url.pathname === botGrantsPath("failed-run-bot"))
        return botGrantsResponse();
      if (url.pathname === botPath("failed-run-bot")) botReads += 1;
      if (
        url.pathname === botPath("failed-run-bot") &&
        runAsked &&
        botRead !== "found"
      )
        return botRead === "not-found"
          ? NativeResponse.json(
              {
                // The API's `BotNotFound` problem, as api/openapi/bots.yaml gives it.
                type: "https://open.bot/errors/bot-not-found",
                title: "Bot not found.",
                status: 404,
                detail: "Couldn't find that Bot.",
                code: "BOT_NOT_FOUND",
                category: "not_found",
                retryable: false,
              },
              {
                status: 404,
                headers: { "content-type": "application/problem+json" },
              },
            )
          : NativeResponse.json({ error: "Bad gateway" }, { status: 502 });
      if (url.pathname === botPath("failed-run-bot"))
        return NativeResponse.json({
          bot: {
            id: "failed-run-bot",
            visibility: "public",
            canManage: true,
          },
        });
      if (url.pathname === botComponentsPath("failed-run-bot"))
        return botComponentsResponse();
      if (url.pathname === MY_CAPABILITIES_PATH)
        return NativeResponse.json({ capabilities: {}, enforced: false });
      if (url.pathname.endsWith("/info"))
        return NativeResponse.json({
          version: "fixture",
          agents: {
            "failed-run-bot": { description: "Fixture", capabilities: {} },
          },
          mode: transport,
          ...(transport === "intelligence"
            ? { intelligence: { wsUrl: "ws://localhost/client" } }
            : {}),
          telemetryDisabled: true,
        });
      if (url.pathname.endsWith("/connect") && transport === "intelligence")
        return new NativeResponse(null, { status: 204 });
      if (url.pathname.endsWith("/connect")) {
        const body = (await request().json()) as { threadId?: string };
        return sse(recorded.get(body.threadId ?? "") ?? []);
      }
      if (url.pathname.endsWith("/run")) {
        runAsked = true;
        return run(RunAgentInputSchema.parse(await request().json()));
      }
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
      // Whether the conversation has a run going, as a quiet run asks: none, here.
      if (
        /^\/api\/v2\/organizations\/default\/conversations\/[^/]+\/join-tokens$/.test(
          url.pathname,
        )
      )
        return NativeResponse.json(
          {
            joinToken: "jt",
            expiresAt: "2026-11-20T00:00:30.000Z",
            threadId: channel.threadId,
            runId: null,
            realtime: { clientUrl: "ws://localhost/client", topic: "thread" },
          },
          { status: 201 },
        );
      // The turns the server refused in this conversation, newest first, on one page.
      if (
        /^\/api\/v2\/organizations\/default\/conversations\/[^/]+\/refused-turns$/.test(
          url.pathname,
        )
      )
        return NativeResponse.json({
          refusedTurns: [...refusedTurns].reverse(),
          nextCursor: null,
        });
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
  refusedTurns = [];
  stalled = null;
  stepsRun = 0;
  botRead = "found";
  runAsked = false;
  botReads = 0;
  transport = "sse";
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

/*
 * Found with the server killed and started again in the middle of a long turn: the backend ends that
 * run "Runner connection dropped", and the conversation opened again said only that.
 */
test("a conversation whose server dropped its run says the turn was cut off after a reload, with Carry on", async () => {
  plans = [{ kind: "fails", message: "Runner connection dropped" }];
  const live = open();
  await send(live, "Write the plan as six files");
  await live.findByTestId("transcript-stopped");
  live.unmount();
  const back = open();
  await settled(back, "Write the plan as six files");
  const restored = await back.findByTestId("transcript-stopped");
  expect(within(restored).getByRole("alert").textContent).toBe(TURN_CUT_OFF);
  within(restored).getByRole("button", { name: "Carry on" });
});

/*
 * A Bot on a Claude plan whose engine went away part way through a reply: the server ends the turn
 * "The connection to Claude dropped. Ask the Bot to carry on." It asks for the Bot to carry on, so
 * the turn offers Carry on, live and in a conversation opened again, as a turn cut off here does.
 */
test("a turn the server says to carry on offers Carry on, live and after a reload", async () => {
  const DROPPED = "The connection to Claude dropped. Ask the Bot to carry on.";
  plans = [{ kind: "fails", message: DROPPED }];
  const live = open();
  await send(live, "Write the tide note for the harbour board");
  const shown = await live.findByTestId("transcript-stopped");
  expect(within(shown).getByRole("alert").textContent).toBe(DROPPED);
  within(shown).getByRole("button", { name: "Carry on" });
  live.unmount();
  const back = open();
  await settled(back, "Write the tide note for the harbour board");
  const restored = await back.findByTestId("transcript-stopped");
  expect(within(restored).getByRole("alert").textContent).toBe(DROPPED);
  within(restored).getByRole("button", { name: "Carry on" });
});

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

const UNREACHABLE =
  "OpenBot couldn't reach its backend, so your message wasn't sent. Try again, or quit and reopen OpenBot.";

test.each(["intelligence", "sse"] as const)(
  "a message to a Bot that was taken away from the person says the Bot isn't shared with them any more (runs over %s)",
  async (how) => {
    // Seen on a real server: an admin took a person out of the team a Bot was shared with while they
    // had a conversation with it open. The next message was refused with 404, and the conversation
    // said OpenBot couldn't reach its backend and to quit and reopen it.
    transport = how;
    stored.set(channel.threadId, [
      { id: "asked", role: "user", content: "What is 586 plus 637?" },
      { id: "answered", role: "assistant", content: "1223" },
    ]);
    const live = open();
    await settled(live, "1223");

    plans = [{ kind: "refused" }];
    botRead = "not-found";
    await send(live, "What is 110 plus 707?");
    const shown = await live.findByTestId("transcript-stopped");
    expect(shown.textContent).toBe(
      "This Bot isn't shared with you any more, so your message wasn't sent. Its owner or an admin can share it again.",
    );
    // What was said before stays readable, and nothing sends them to retry or reopen.
    expect(live.queryByText("What is 586 plus 637?")).not.toBeNull();
    expect(live.queryByText("1223")).not.toBeNull();
    expect(live.queryByText(/quit and reopen/)).toBeNull();
    expect(live.queryByText(/Try again/)).toBeNull();
  },
);

test.each([
  ["the back end cannot be reached at all", "unreachable", "found"],
  ["the back end answers with a server error", "breaks", "breaks"],
  ["the run is refused but the Bot is still theirs", "refused", "found"],
  ["the run is refused and the Bot cannot be read", "refused", "breaks"],
] as const)(
  "a message that is not sent because %s still says the back end couldn't be reached",
  async (_why, kind, read) => {
    transport = "intelligence";
    plans = [{ kind }];
    botRead = read;
    const live = open();
    await send(live, "Summarise my inbox");
    const shown = await live.findByTestId("transcript-stopped");
    expect(shown.textContent).toBe(UNREACHABLE);
  },
);

test("a Bot that says why it failed is not asked about again", async () => {
  // A run that failed in its own words is not a request that was not made: the Bot is not re-read.
  plans = [{ kind: "fails", message: REJECTED }];
  const live = open();
  await send(live, "Summarise my inbox");
  const before = botReads;
  expect((await live.findByTestId("transcript-stopped")).textContent).toBe(
    REJECTED,
  );
  expect(botReads).toBe(before);
});

/** What is typed in the composer: the editor the words live in. */
function typed(view: ReturnType<typeof open>): string {
  return (
    view.container.querySelector("[contenteditable]")?.textContent ?? ""
  ).trim();
}

/*
 * FOUND IN DOGFOODING. A Bot looked up HubSpot deals for five minutes, then its run failed, and the
 * person's message came back in the box, ready to send again. Sent again, it runs the whole request
 * from the start and repeats what already ran. A turn that never got going still hands its words
 * back, so they can be sent once it can.
 */
test("a turn that failed after it had done some work keeps its message sent, and the box stays empty", async () => {
  const FAILED =
    "Claude's reply came back incomplete, so the Bot stopped. Ask it to carry on.";
  plans = [
    {
      kind: "worksThenFails",
      text: "Looking up deals at S1 and later.",
      message: FAILED,
    },
  ];
  const live = open();
  await send(live, "Find all HubSpot deals at S1 and later");
  const stopped = await live.findByTestId("transcript-stopped");
  expect(within(stopped).getByRole("alert").textContent).toBe(FAILED);
  // It asks for the Bot to carry on, so the turn offers that with one press.
  within(stopped).getByRole("button", { name: "Carry on" });
  await waitFor(() =>
    expect(live.queryByRole("button", { name: "Stop the Bot" })).toBeNull(),
  );
  expect(typed(live)).toBe("");
  // Once, where it was sent.
  expect(
    live.getAllByText("Find all HubSpot deals at S1 and later"),
  ).toHaveLength(1);
});

/*
 * FOUND ON A CLOUD 1.2.0-rc.1 DOGFOOD. A Bot's connection to its model was cut part way, and the run
 * ended with the fetch's own words, which the conversation showed in red: no sentence saying the
 * turn ended, no Carry on. Sent again, the next turn was cut before it did anything, and the words
 * were put back in the box as if the message had never gone.
 */
const SOCKET_CLOSED =
  "ECONNRESET: The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()";

test("a turn whose connection is cut never shows the raw words: it says the Bot stopped, keeps the message sent, and Carry on finishes it", async () => {
  plans = [
    { kind: "fails", message: SOCKET_CLOSED },
    { kind: "answers", text: "Both pages say the app is free." },
  ];
  const live = open();
  await send(live, "Compare the home page and the pricing page");
  const stopped = await live.findByTestId("transcript-stopped");
  expect(within(stopped).getByRole("alert").textContent).toBe(TURN_CUT_OFF);
  expect(live.queryByText(/ECONNRESET|socket connection/)).toBeNull();
  await waitFor(() =>
    expect(live.queryByRole("button", { name: "Stop the Bot" })).toBeNull(),
  );
  // The message went: it is not handed back to send again.
  expect(typed(live)).toBe("");
  expect(
    live.getAllByText("Compare the home page and the pricing page"),
  ).toHaveLength(1);

  const user = userEvent.setup({ document: live.container.ownerDocument });
  await user.click(within(stopped).getByRole("button", { name: "Carry on" }));
  await live.findByText("Both pages say the app is free.");
  expect(live.queryByTestId("transcript-stopped")).toBeNull();
});

test("a turn the server says to carry on keeps its message sent, even before it did anything", async () => {
  const DROPPED = "The connection to Claude dropped. Ask the Bot to carry on.";
  plans = [{ kind: "fails", message: DROPPED }];
  const live = open();
  await send(live, "Compare the home page and the pricing page");
  const stopped = await live.findByTestId("transcript-stopped");
  expect(within(stopped).getByRole("alert").textContent).toBe(DROPPED);
  within(stopped).getByRole("button", { name: "Carry on" });
  await waitFor(() =>
    expect(live.queryByRole("button", { name: "Stop the Bot" })).toBeNull(),
  );
  expect(typed(live)).toBe("");
});

/*
 * FOUND ON THE PER-TEAM MODELS END-TO-END RUN. A later turn the server refused (the Bot's model
 * isn't one the person's teams allow) put its words back in the box with Send ready, under a notice
 * saying an admin has to change the team's models; sent again, it was refused again. The same
 * refusal on a conversation's first message leaves the box empty, its message sent. Now a later
 * turn does too.
 */
test("a turn the server refused for the person keeps its message sent, and the box stays empty, as on a first message", async () => {
  const MODEL_REFUSED =
    "This Bot uses GPT-4.1, which your team's models don't include. Ask an admin to change your team's models.";
  transport = "intelligence";
  stored.set(channel.threadId, [
    {
      id: "asked",
      role: "user",
      content: "Name one primary colour, one word only.",
    },
    { id: "answered", role: "assistant", content: "Red" },
  ]);
  const live = open();
  await settled(live, "Red");

  plans = [{ kind: "forbidden", detail: MODEL_REFUSED }];
  await send(live, "Name one more primary colour, one word only.");
  const stopped = await live.findByTestId("transcript-stopped");
  expect(within(stopped).getByRole("alert").textContent).toBe(MODEL_REFUSED);
  await waitFor(() =>
    expect(live.queryByRole("button", { name: "Stop the Bot" })).toBeNull(),
  );
  // Not handed back to be refused again: the box is empty, the message shown once, where it was sent.
  expect(typed(live)).toBe("");
  expect(
    live.getAllByText("Name one more primary colour, one word only."),
  ).toHaveLength(1);
});

test("two turns refused in a row each keep their own notice, under their own message", async () => {
  const MODEL_REFUSED =
    "This Bot uses GPT-4.1, which your team's models don't include. Ask an admin to change your team's models.";
  transport = "intelligence";
  stored.set(channel.threadId, [
    {
      id: "asked",
      role: "user",
      content: "Name one primary colour, one word only.",
    },
    { id: "answered", role: "assistant", content: "Red" },
  ]);
  const live = open();
  await settled(live, "Red");

  plans = [{ kind: "forbidden", detail: MODEL_REFUSED }];
  await send(live, "Say goodbye in one word.");
  await live.findByTestId("transcript-stopped");
  await waitFor(() =>
    expect(live.queryByRole("button", { name: "Stop the Bot" })).toBeNull(),
  );

  // The first turn is over: its message stays sent and the box is empty again.
  await waitFor(() => expect(typed(live)).toBe(""));

  plans = [{ kind: "forbidden", detail: MODEL_REFUSED }];
  const user = userEvent.setup({ document: live.container.ownerDocument });
  await user.type(
    await live.findByRole("textbox", { name: "Message" }),
    "And once more, one word.",
  );
  await user.click(await live.findByRole("button", { name: "Send message" }));
  // The second refusal adds its notice; the first one's stays. One drew, the second's, before.
  await waitFor(() =>
    expect(live.getAllByTestId("transcript-stopped")).toHaveLength(2),
  );
  // Each under its own message: the message's row holds its notice.
  for (const words of [
    "Say goodbye in one word.",
    "And once more, one word.",
  ]) {
    const row = live
      .getByText(words)
      .closest("[data-slot=message-scroller-item]") as HTMLElement;
    expect(within(row).getByTestId("transcript-stopped").textContent).toBe(
      MODEL_REFUSED,
    );
  }
  // The server's record, read again after each live refusal, adds nothing twice.
  await waitFor(() => expect(refusedTurns).toHaveLength(2));
  await new Promise((settle) => setTimeout(settle, 50));
  expect(live.getAllByTestId("transcript-stopped")).toHaveLength(2);
  expect(live.getAllByText("Say goodbye in one word.")).toHaveLength(1);

  // Reloaded: a fresh page and query cache, the thread holding none of it. The server's record
  // puts both messages back where they were sent, each with its notice under it.
  cleanup();
  queryClient.clear();
  const back = open();
  await back.findByText("Red");
  await waitFor(() =>
    expect(back.getAllByTestId("transcript-stopped")).toHaveLength(2),
  );
  const rows = back
    .getAllByText(
      /^(Name one primary colour, one word only\.|Red|Say goodbye in one word\.|And once more, one word\.)$/,
    )
    .map((node) => node.textContent);
  expect(rows).toEqual([
    "Name one primary colour, one word only.",
    "Red",
    "Say goodbye in one word.",
    "And once more, one word.",
  ]);
  for (const words of [
    "Say goodbye in one word.",
    "And once more, one word.",
  ]) {
    const row = back
      .getByText(words)
      .closest("[data-slot=message-scroller-item]") as HTMLElement;
    expect(within(row).getByTestId("transcript-stopped").textContent).toBe(
      MODEL_REFUSED,
    );
  }
});

test("a turn that failed before it did anything hands the words back to send again", async () => {
  plans = [{ kind: "fails", message: REJECTED }];
  const live = open();
  await send(live, "Summarise my inbox");
  await live.findByTestId("transcript-stopped");
  await waitFor(() => expect(typed(live)).toBe("Summarise my inbox"));
});

/*
 * FOUND ON A PERSON'S 1.1.2 DESKTOP. The server stopped and started again in the middle of a long
 * turn of file saves. The run that would have carried the last save's result back was never made,
 * and its failure was dropped as if the person had pressed Stop: the turn ended with nothing said.
 */
test("a turn whose backend stops answering after a browser step says so, and offers to carry on", async () => {
  plans = [
    { kind: "calls", tool: STEP },
    { kind: "unreachable" },
    { kind: "answers", text: "Picking up where I stopped." },
  ];
  const live = open();
  await send(live, "Write the plan as six files");
  const shown = await live.findByTestId("transcript-stopped");
  expect(within(shown).getByRole("alert").textContent).toBe(TURN_CUT_OFF);
  expect(stepsRun).toBe(1);
  await waitFor(() =>
    expect(live.queryByRole("button", { name: "Stop the Bot" })).toBeNull(),
  );
  // The message went and the Bot worked on it, so it is not handed back to send again.
  expect(typed(live)).toBe("");
  const user = userEvent.setup({ document: live.container.ownerDocument });
  await user.click(within(shown).getByRole("button", { name: "Carry on" }));
  await live.findByText("Picking up where I stopped.");
  await waitFor(() =>
    expect(live.queryByTestId("transcript-stopped")).toBeNull(),
  );
});

/*
 * Found on WebKit with the server killed right after the browser sent the run carrying a save's
 * result: nothing of that run ever came, the watch was still resting from the run before, and the
 * server's "no run going" read as the step still being taken. "Thinking" for good, with Stop up.
 */
test("a run started after a browser step that never answers ends the turn once the server has no run", async () => {
  const period = quietRunPeriod.ms;
  quietRunPeriod.ms = 200;
  try {
    plans = [{ kind: "calls", tool: STEP }, { kind: "silent" }];
    const live = open();
    await send(live, "Write the plan as six files");
    const shown = await live.findByTestId(
      "transcript-stopped",
      {},
      // The quiet period, and then the stored thread read back (up to five and a half seconds).
      { timeout: 15_000 },
    );
    expect(within(shown).getByRole("alert").textContent).toBe(
      RUN_ENDED_UNHEARD,
    );
    within(shown).getByRole("button", { name: "Carry on" });
    await waitFor(() =>
      expect(live.queryByRole("button", { name: "Stop the Bot" })).toBeNull(),
    );
  } finally {
    quietRunPeriod.ms = period;
  }
}, 20_000);

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
