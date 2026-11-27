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
import { z } from "zod";
import { ChannelChat } from "@/components/channels/channel-chat";
import {
  type AgentChannel,
  type ChannelPage,
  type ChannelSummary,
  channelKeys,
} from "@/lib/channels/queries";
import { quietRunPeriod, RUN_ENDED_UNHEARD } from "@/lib/copilot/quiet-run";
import { queryClient } from "@/query-client";
import { MY_CAPABILITIES_PATH } from "./admin-settings-api";
import { botGrantsPath, botGrantsResponse } from "./bot-grants-api";
import { answerBotsList, botPath } from "./bots-api";
import { botComponentsPath, botComponentsResponse } from "./components-api";
import { settleReactWork } from "./settle-react-work";

/**
 * A turn the server carries on by itself, followed by the page.
 *
 * The server runs a Bot's computer steps in the run and answers them there, so the page only draws
 * them, and it carries a person's turn on in a run of its own: past one run's step limit or deadline,
 * or on another server after the one running it stopped. Before the page followed such a turn, a page
 * that heard its own run end showed the steps up to there and no answer, with nothing working, and a
 * page that slept through the run that stopped woke to "The Bot stopped before it finished" under a
 * turn the server had carried to its answer.
 *
 * End to end in the app: the real conversation and the CopilotKit core, against a runtime that
 * answers as the real one does. A run streams its events; a join while a run is live sends the thread
 * so far and that run's events as they come, until it ends; a join with nothing live replays the
 * thread's last run. The server keeps each run's ending, and says which run is going.
 */

const BOT = "carried-bot";
const channel: AgentChannel = {
  id: "carried-channel",
  name: "Report",
  agentIds: [BOT],
  threadId: "carried-thread",
  active: true,
  lastMessageAt: "2026-11-26T00:00:00.000Z",
};
const NativeResponse = globalThis.Response;
const encoder = new TextEncoder();

const ASKED =
  "Write the numbers to a file, add them up, and tell me the total.";
const ABOUT_TO = "I'll save the numbers and add them up on my computer.";
const SAVED = "numbers.txt";
const COMMAND = "paste -sd+ numbers.txt | bc";
const PRINTED = "1234";
const DONE = "The total is 1234.";

let runs: RunAgentInput[] = [];
/** The thread as the server has stored it. */
let stored: Message[] = [];
/** How each run ended, as the server keeps it. */
let endings = new Map<string, "succeeded" | "failed">();
/** The thread's last run, which a join with nothing live replays. */
let lastRun: string | null = null;
/** The run live on the thread: its events so far, and the joins following it. */
let live: {
  runId: string;
  events: unknown[];
  followers: Set<ReadableStreamDefaultController<Uint8Array>>;
} | null = null;
/** How the next run the page asks for goes. */
let onRun: (input: RunAgentInput) => Response = () => {
  throw new Error("A run nobody planned for");
};
/** Each time this page ran a computer step itself. Never, when the server runs them. */
let stepsRunHere = 0;
/** The stops the runtime was asked for, by address. */
let stops: string[] = [];
/** Whether the server refuses a Stop, as it does for a turn that is not the asker's. */
let stopRefused = false;
let originalFetch: typeof fetch;

const frame = (event: unknown) =>
  encoder.encode(`data: ${JSON.stringify(event)}\n\n`);
function sse(events: unknown[]) {
  return new NativeResponse(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
}
function streaming(
  start: (controller: ReadableStreamDefaultController<Uint8Array>) => void,
) {
  return new NativeResponse(new ReadableStream<Uint8Array>({ start }), {
    headers: { "content-type": "text/event-stream" },
  });
}

/** The events of a computer step the server ran in the run: the call, then its result. */
function serverStep(
  toolCallId: string,
  name: string,
  args: Record<string, unknown>,
  parentMessageId: string,
  result: Record<string, unknown>,
): unknown[] {
  return [
    {
      type: "TOOL_CALL_START",
      toolCallId,
      toolCallName: name,
      parentMessageId,
    },
    { type: "TOOL_CALL_ARGS", toolCallId, delta: JSON.stringify(args) },
    { type: "TOOL_CALL_END", toolCallId },
    {
      type: "TOOL_CALL_RESULT",
      messageId: `result-${toolCallId}`,
      toolCallId,
      role: "tool",
      content: JSON.stringify(result),
    },
  ];
}
const said = (messageId: string, text: string) => [
  { type: "TEXT_MESSAGE_START", messageId, role: "assistant" },
  { type: "TEXT_MESSAGE_CONTENT", messageId, delta: text },
  { type: "TEXT_MESSAGE_END", messageId },
];

/** The thread as it stands once the server has run both steps and answered. */
function wholeTurn(person: Message[]): Message[] {
  return [
    ...person,
    {
      id: "about",
      role: "assistant",
      content: ABOUT_TO,
      toolCalls: [
        {
          id: "save",
          type: "function",
          function: {
            name: "computer_write_file",
            arguments: JSON.stringify({ path: SAVED, contents: "1000\n234" }),
          },
        },
      ],
    },
    {
      id: "result-save",
      role: "tool",
      toolCallId: "save",
      content: JSON.stringify({ ok: true, path: SAVED, bytes: 8 }),
    },
    {
      id: "adds",
      role: "assistant",
      content: "",
      toolCalls: [
        {
          id: "add",
          type: "function",
          function: {
            name: "computer_run_command",
            arguments: JSON.stringify({ command: COMMAND }),
          },
        },
      ],
    },
    {
      id: "result-add",
      role: "tool",
      toolCallId: "add",
      content: JSON.stringify({ ok: true, exitCode: 0, stdout: PRINTED }),
    },
    { id: "done", role: "assistant", content: DONE },
  ];
}

/** A join: the thread so far, then the live run's events as they come until it ends; or the last run. */
function connect(): Response {
  if (!live) {
    const runId = lastRun ?? "join";
    return sse([
      { type: "RUN_STARTED", threadId: channel.threadId, runId },
      { type: "MESSAGES_SNAPSHOT", messages: stored },
      { type: "RUN_FINISHED", threadId: channel.threadId, runId },
    ]);
  }
  const following = live;
  return streaming((controller) => {
    controller.enqueue(
      frame({
        type: "RUN_STARTED",
        threadId: channel.threadId,
        runId: following.runId,
      }),
    );
    controller.enqueue(frame({ type: "MESSAGES_SNAPSHOT", messages: stored }));
    for (const event of following.events) controller.enqueue(frame(event));
    following.followers.add(controller);
  });
}

/** One event of the live run, to every join following it. */
function emit(event: unknown) {
  if (!live) throw new Error("No run is live");
  live.events.push(event);
  for (const follower of live.followers) follower.enqueue(frame(event));
}
function endLive() {
  if (!live) return;
  const followers = live.followers;
  lastRun = live.runId;
  live = null;
  for (const follower of followers) follower.close();
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
        return onRun(body);
      }
      if (/\/agent\/[^/]+\/stop\//.test(url.pathname)) {
        stops.push(url.pathname);
        return stopRefused
          ? NativeResponse.json(
              { error: "Thread access denied" },
              { status: 403 },
            )
          : NativeResponse.json({ stopped: true });
      }
      if (url.pathname.match(/\/threads\/[^/]+\/messages$/))
        return NativeResponse.json({ messages: stored });
      // Which run is going in the conversation, as a join token names it.
      if (
        url.pathname ===
        `/api/v2/organizations/default/conversations/${channel.id}/join-tokens`
      )
        return NativeResponse.json(
          {
            joinToken: "jt",
            expiresAt: "2026-11-26T00:00:30.000Z",
            threadId: channel.threadId,
            runId: live?.runId ?? null,
            realtime: { clientUrl: "ws://localhost/client", topic: "thread" },
          },
          { status: 201 },
        );
      // How a run ended, as getConversationRun answers: not found for a run with no ending kept.
      const ran = url.pathname.match(
        /^\/api\/v2\/organizations\/default\/conversations\/[^/]+\/runs\/([^/]+)$/,
      );
      if (ran) {
        const runId = decodeURIComponent(ran[1] ?? "");
        const outcome = endings.get(runId);
        if (outcome)
          return NativeResponse.json({
            run: { id: runId, outcome, endedAt: "2026-11-26T00:01:00.000Z" },
          });
        return NativeResponse.json(
          {
            type: "https://open.bot/errors/conversation-run-not-found",
            title: "Run not found.",
            status: 404,
            detail: "Couldn't find that run in this conversation.",
            code: "CONVERSATION_RUN_NOT_FOUND",
            category: "not_found",
            retryable: false,
          },
          {
            status: 404,
            headers: { "content-type": "application/problem+json" },
          },
        );
      }
      const bots = answerBotsList(url, init, { visible: [] });
      if (bots) return bots;
      if (url.pathname === botPath(BOT))
        return NativeResponse.json({
          bot: { id: BOT, visibility: "public", canManage: true },
        });
      if (url.pathname === botComponentsPath(BOT))
        return botComponentsResponse();
      if (url.pathname === MY_CAPABILITIES_PATH)
        return NativeResponse.json({ capabilities: {}, enforced: false });
      if (url.pathname === botGrantsPath(BOT)) return botGrantsResponse();
      if (
        /^\/api\/v2\/organizations\/default\/conversations\/[^/]+\/voice-sessions$/.test(
          url.pathname,
        )
      )
        return NativeResponse.json({ sessions: [], nextCursor: null });
      if (
        /^\/api\/v2\/organizations\/default\/conversations\/[^/]+\/refused-turns$/.test(
          url.pathname,
        )
      )
        return NativeResponse.json({ refusedTurns: [], nextCursor: null });
      if (
        /^\/api\/v2\/organizations\/default\/conversations\/[^/]+\/(activity|signal-busy)$/.test(
          url.pathname,
        )
      )
        return new NativeResponse(null, { status: 204 });
      if (
        /^\/api\/v2\/organizations\/default\/people\/me\/approval-modes\/[^/]+$/.test(
          url.pathname,
        )
      )
        return NativeResponse.json({ asksEveryStep: false });
      return NativeResponse.json({ error: "Not found" }, { status: 404 });
    },
    { preconnect: () => undefined },
  );
});
let period = quietRunPeriod.ms;
beforeEach(() => {
  period = quietRunPeriod.ms;
  quietRunPeriod.ms = 300;
  runs = [];
  stored = [];
  endings = new Map();
  lastRun = null;
  live = null;
  stepsRunHere = 0;
  stops = [];
  stopRefused = false;
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
afterEach(() => {
  quietRunPeriod.ms = period;
  cleanup();
});
afterAll(async () => {
  await settleReactWork();
  globalThis.fetch = originalFetch;
  GlobalRegistrator.unregister();
});

/**
 * The computer's steps as the page registers them: drawn from their result, and a handler this page
 * would run them with. A server that runs them in the run answers them there, so it never runs.
 */
function ComputerStep({ name }: { name: string }) {
  useFrontendTool({
    name,
    description: "A computer step.",
    parameters: z.object({}).passthrough(),
    handler: async () => {
      stepsRunHere += 1;
      return { ok: false, reason: "Not run here." };
    },
    render: ({ result }) => (
      <p>{`${name} answered ${typeof result === "string" ? result : "nothing yet"}`}</p>
    ),
  });
  return null;
}
function ComputerSteps() {
  return (
    <>
      <ComputerStep name="computer_write_file" />
      <ComputerStep name="computer_run_command" />
    </>
  );
}

/** The conversation as the roster has it: its work too, which the socket keeps up to date. */
function app(shown: AgentChannel = channel) {
  return (
    <QueryClientProvider client={queryClient}>
      <CopilotKitProvider runtimeUrl="http://localhost/api/copilotkit">
        <ComputerSteps />
        <ChannelChat channel={shown} runtimeAgentId={BOT} />
      </CopilotKitProvider>
    </QueryClientProvider>
  );
}

/** The conversation's work while the server carries the person's turn on. */
const CARRYING: AgentChannel = {
  ...channel,
  work: [
    {
      kind: "turn",
      key: "turn-1",
      botId: BOT,
      botName: "Carried Bot",
      since: "2026-11-26T00:00:00.000Z",
    } as never,
  ],
};

async function send(view: ReturnType<typeof render>, text: string) {
  const user = userEvent.setup({ document: view.container.ownerDocument });
  await user.type(await view.findByRole("textbox", { name: "Message" }), text);
  await user.click(view.getByRole("button", { name: "Send message" }));
}

test("a turn the server carried on while this page slept shows every step and the answer, with no stopped notice", async () => {
  onRun = (input) => {
    const person = input.messages.filter((message) => message.role === "user");
    stored = [...person];
    // On the server: the run took the first step and stopped part way through the second, its
    // server gone. Another server carried the turn on in a run of its own, ran the step and answered.
    stored = wholeTurn(person);
    endings.set("carried-on", "succeeded");
    lastRun = "carried-on";
    // What reached this page, which slept: the start, the first step with its result, and the
    // second step asked for. Then nothing, ever.
    const heard = [
      { type: "RUN_STARTED", threadId: input.threadId, runId: input.runId },
      ...said("about", ABOUT_TO),
      ...serverStep(
        "save",
        "computer_write_file",
        { path: SAVED, contents: "1000\n234" },
        "about",
        { ok: true, path: SAVED, bytes: 8 },
      ),
      {
        type: "TOOL_CALL_START",
        toolCallId: "add",
        toolCallName: "computer_run_command",
        parentMessageId: "adds",
      },
    ];
    return streaming((controller) => {
      for (const event of heard) controller.enqueue(frame(event));
    });
  };
  const view = render(app());
  await send(view, ASKED);

  expect(await view.findByText(DONE, {}, { timeout: 15_000 })).toBeTruthy();
  await waitFor(
    () =>
      expect(view.queryByRole("button", { name: "Stop the Bot" })).toBeNull(),
    { timeout: 15_000 },
  );
  // Every step, drawn from the result the server gave it.
  view.getByText(/computer_write_file answered .*numbers\.txt/);
  view.getByText(/computer_run_command answered .*1234/);
  // No notice, no Carry on, and nothing run here or asked of the Bot again.
  expect(view.queryByTestId("transcript-stopped")).toBeNull();
  expect(view.queryByText(RUN_ENDED_UNHEARD)).toBeNull();
  expect(view.queryByRole("button", { name: "Carry on" })).toBeNull();
  expect(stepsRunHere).toBe(0);
  expect(runs).toHaveLength(1);
}, 30_000);

test("a turn the server carries on in a run of its own is followed here while it works, to its answer", async () => {
  let finish = () => {};
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });
  onRun = (input) => {
    const person = input.messages.filter((message) => message.role === "user");
    const whole = wholeTurn(person);
    // The run took the first step and ended there, its server leaving: another server carries the
    // turn on in a run of its own, which this page's run does not bring.
    stored = whole.slice(0, person.length + 2);
    endings.set(input.runId, "succeeded");
    live = { runId: "carried-on", events: [], followers: new Set() };
    void (async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      for (const event of serverStep(
        "add",
        "computer_run_command",
        { command: COMMAND },
        "adds",
        { ok: true, exitCode: 0, stdout: PRINTED },
      ))
        emit(event);
      await finished;
      for (const event of said("done", DONE)) emit(event);
      stored = whole;
      endings.set("carried-on", "succeeded");
      emit({
        type: "RUN_FINISHED",
        threadId: channel.threadId,
        runId: "carried-on",
      });
      endLive();
    })();
    return sse([
      { type: "RUN_STARTED", threadId: input.threadId, runId: input.runId },
      ...said("about", ABOUT_TO),
      ...serverStep(
        "save",
        "computer_write_file",
        { path: SAVED, contents: "1000\n234" },
        "about",
        { ok: true, path: SAVED, bytes: 8 },
      ),
      { type: "RUN_FINISHED", threadId: input.threadId, runId: input.runId },
    ]);
  };
  const view = render(app());
  await send(view, ASKED);

  // The server's run streams in here: its step, drawn from its result, while the Bot still works.
  await view.findByText(
    /computer_run_command answered .*1234/,
    {},
    { timeout: 15_000 },
  );
  expect(view.getByRole("button", { name: "Stop the Bot" })).toBeTruthy();
  expect(view.queryByText(DONE)).toBeNull();

  finish();
  expect(await view.findByText(DONE, {}, { timeout: 15_000 })).toBeTruthy();
  await waitFor(
    () =>
      expect(view.queryByRole("button", { name: "Stop the Bot" })).toBeNull(),
    { timeout: 15_000 },
  );
  view.getByText(/computer_write_file answered .*numbers\.txt/);
  expect(view.queryByTestId("transcript-stopped")).toBeNull();
  expect(stepsRunHere).toBe(0);
  expect(runs).toHaveLength(1);
}, 30_000);

/*
 * The connection this page's run came through is lost (a phone's drops, or the server it came
 * through leaves), and its stream ends in an error, while the run goes on on the server to its
 * answer. The page rejoins and follows it, and says nothing of a failure.
 */
test("a run whose stream is lost here while it goes on is rejoined and followed to its answer, with no failure said", async () => {
  const LOST = "The connection to OpenBot was lost.";
  onRun = (input) => {
    const person = input.messages.filter((message) => message.role === "user");
    const whole = wholeTurn(person);
    stored = whole.slice(0, person.length + 2);
    // The same run, still going on the server once this page's stream of it has ended.
    live = { runId: input.runId, events: [], followers: new Set() };
    void (async () => {
      await new Promise((resolve) => setTimeout(resolve, 300));
      for (const event of serverStep(
        "add",
        "computer_run_command",
        { command: COMMAND },
        "adds",
        { ok: true, exitCode: 0, stdout: PRINTED },
      ))
        emit(event);
      for (const event of said("done", DONE)) emit(event);
      stored = whole;
      endings.set(input.runId, "succeeded");
      emit({
        type: "RUN_FINISHED",
        threadId: channel.threadId,
        runId: input.runId,
      });
      endLive();
    })();
    return sse([
      { type: "RUN_STARTED", threadId: input.threadId, runId: input.runId },
      ...said("about", ABOUT_TO),
      ...serverStep(
        "save",
        "computer_write_file",
        { path: SAVED, contents: "1000\n234" },
        "about",
        { ok: true, path: SAVED, bytes: 8 },
      ),
      { type: "RUN_ERROR", message: LOST, code: "connection_lost" },
    ]);
  };
  const view = render(app());
  await send(view, ASKED);

  expect(await view.findByText(DONE, {}, { timeout: 15_000 })).toBeTruthy();
  await waitFor(
    () =>
      expect(view.queryByRole("button", { name: "Stop the Bot" })).toBeNull(),
    { timeout: 15_000 },
  );
  view.getByText(/computer_run_command answered .*1234/);
  expect(view.queryByTestId("transcript-stopped")).toBeNull();
  expect(view.queryByText(LOST)).toBeNull();
  expect(stepsRunHere).toBe(0);
  expect(runs).toHaveLength(1);
}, 30_000);

/*
 * The server hands a long turn to a fresh run when the server running it leaves, and between the two
 * no run is going. The conversation's work says the server is still carrying the turn (`turn`), so
 * the conversation stays working through the gap, a message typed then waits, and the next run is
 * followed to the answer when it starts.
 */
test("between two runs of a turn the server carries, the conversation stays working and follows the next run to its answer", async () => {
  let whole: Message[] = [];
  onRun = (input) => {
    const person = input.messages.filter((message) => message.role === "user");
    whole = wholeTurn(person);
    stored = whole.slice(0, person.length + 2);
    endings.set(input.runId, "succeeded");
    return sse([
      { type: "RUN_STARTED", threadId: input.threadId, runId: input.runId },
      ...said("about", ABOUT_TO),
      ...serverStep(
        "save",
        "computer_write_file",
        { path: SAVED, contents: "1000\n234" },
        "about",
        { ok: true, path: SAVED, bytes: 8 },
      ),
      { type: "RUN_FINISHED", threadId: input.threadId, runId: input.runId },
    ]);
  };
  const view = render(app());
  await send(view, ASKED);
  await view.findByText(
    /computer_write_file answered .*numbers\.txt/,
    {},
    { timeout: 15_000 },
  );
  // The socket says the server is carrying the turn on; no run is going yet.
  view.rerender(app(CARRYING));
  await new Promise((resolve) => setTimeout(resolve, 800));
  // Still working, and nothing says it stopped.
  expect(view.getByRole("log").getAttribute("aria-busy")).toBe("true");
  expect(view.queryByTestId("transcript-stopped")).toBeNull();
  expect(view.queryByText(/running a routine/)).toBeNull();

  // The next run starts on the server, and streams in here.
  live = { runId: "carried-on", events: [], followers: new Set() };
  await waitFor(() => expect(live?.followers.size ?? 0).toBeGreaterThan(0), {
    timeout: 15_000,
  });
  for (const event of serverStep(
    "add",
    "computer_run_command",
    { command: COMMAND },
    "adds",
    { ok: true, exitCode: 0, stdout: PRINTED },
  ))
    emit(event);
  for (const event of said("done", DONE)) emit(event);
  stored = whole;
  endings.set("carried-on", "succeeded");
  emit({
    type: "RUN_FINISHED",
    threadId: channel.threadId,
    runId: "carried-on",
  });
  endLive();
  expect(await view.findByText(DONE, {}, { timeout: 15_000 })).toBeTruthy();
  view.getByText(/computer_run_command answered .*1234/);

  // The turn is over: the conversation is free again.
  view.rerender(app());
  await waitFor(
    () => expect(view.getByRole("log").getAttribute("aria-busy")).toBe("false"),
    { timeout: 15_000 },
  );
  expect(view.queryByTestId("transcript-stopped")).toBeNull();
  expect(stepsRunHere).toBe(0);
  expect(runs).toHaveLength(1);
}, 30_000);

/*
 * Stop works at every moment of a turn the server carries, the gap between two runs included, where
 * no run is going for a Stop to reach. It asks the server to stop the turn in the thread, and the
 * conversation stops reading as working at once, with nothing saying the Bot stopped on its own.
 */
/** A turn the server carries, between its runs, with Stop up and pressed. */
async function stopInTheGap() {
  onRun = (input) => {
    const person = input.messages.filter((message) => message.role === "user");
    stored = wholeTurn(person).slice(0, person.length + 2);
    endings.set(input.runId, "succeeded");
    return sse([
      { type: "RUN_STARTED", threadId: input.threadId, runId: input.runId },
      ...said("about", ABOUT_TO),
      ...serverStep(
        "save",
        "computer_write_file",
        { path: SAVED, contents: "1000\n234" },
        "about",
        { ok: true, path: SAVED, bytes: 8 },
      ),
      { type: "RUN_FINISHED", threadId: input.threadId, runId: input.runId },
    ]);
  };
  const view = render(app());
  await send(view, ASKED);
  await view.findByText(
    /computer_write_file answered .*numbers\.txt/,
    {},
    { timeout: 15_000 },
  );
  view.rerender(app(CARRYING));
  // No run is going, and the person can still stop the turn.
  const stop = await view.findByRole(
    "button",
    { name: "Stop the Bot" },
    { timeout: 15_000 },
  );
  stops = [];
  const user = userEvent.setup({ document: view.container.ownerDocument });
  await user.click(stop);
  // The server is asked to stop the turn in this thread.
  await waitFor(() => expect(stops.length).toBeGreaterThan(0), {
    timeout: 5_000,
  });
  expect(
    stops.every((path) => path.endsWith(`/stop/${channel.threadId}`)),
  ).toBe(true);
  return view;
}

test("Stop between two runs of a turn the server carries stops the turn, and the conversation is free at once", async () => {
  const view = await stopInTheGap();
  await waitFor(
    () => expect(view.getByRole("log").getAttribute("aria-busy")).toBe("false"),
    { timeout: 5_000 },
  );
  expect(view.queryByRole("button", { name: "Stop the Bot" })).toBeNull();
  expect(view.queryByTestId("transcript-stopped")).toBeNull();
  expect(runs).toHaveLength(1);
}, 30_000);

test("a Stop the server refuses says so, and the turn it didn't stop still reads as working", async () => {
  stopRefused = true;
  const view = await stopInTheGap();
  const said = await view.findByTestId(
    "transcript-stopped",
    {},
    { timeout: 5_000 },
  );
  // The person's words, never the runtime's ("Thread access denied").
  expect(said.textContent).toContain("Couldn't stop the Bot. Try again.");
  expect(said.textContent).not.toContain("Thread access denied");
  expect(view.getByRole("log").getAttribute("aria-busy")).toBe("true");
  expect(view.getByRole("button", { name: "Stop the Bot" })).toBeTruthy();
}, 30_000);
