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
import type { ComputerControlState } from "@openbot/shared/computer-control";
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
import { ActiveBotProvider } from "@/lib/copilot/active-bot";
import { ComputerTools } from "@/lib/copilot/computer-tools";
import { queryClient } from "@/query-client";
import { settleReactWork } from "./settle-react-work";

/**
 * A Bot asking the person to take over its browser, end to end in the app: the real chat, the real computer tools
 * and the CopilotKit core running them, against a runtime and a computer that answer as the real ones do. The Bot's
 * runs are streamed AG-UI events; its help request is the real frontend tool, which raises the request on the computer
 * and waits on it; handing back completes the request as the computer's own release does; and the Bot's next run is
 * the one the core starts with the tool's answer, stored in the thread as the runtime stores it.
 */

const BOT = "help-bot";
const ASKED = "Enter your phone number in the Telephone field.";
const REPLY = "Thanks. Next I will check the form and submit it.";
const channel: AgentChannel = {
  id: "help-channel",
  name: "Help test",
  agentIds: [BOT],
  threadId: "help-thread",
  active: true,
  lastMessageAt: "2026-10-28T00:00:00.000Z",
};
const NativeResponse = globalThis.Response;

let control: ComputerControlState;
let runs: RunAgentInput[] = [];
/** The thread as the runtime has stored it: every message a finished run carried, and what it answered. */
let stored: Message[] = [];
/** What the Bot answers after the hand-back: words, or nothing at all. */
let replyAfterHandBack: string | null = REPLY;
/** Holds the Bot's run after the hand-back until released, so what the screen says meanwhile can be read. */
let holdAnswer: Promise<void> = Promise.resolve();
let originalFetch: typeof fetch;
let originalDecode: typeof HTMLImageElement.prototype.decode;
let originalSocket: typeof WebSocket;

/** The live screen's socket, which nothing here answers: the screen is not what these cases are about. */
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

const SINCE = "2026-10-28T00:00:00.000Z";
function botHolds(): ComputerControlState {
  return {
    holder: "bot",
    since: SINCE,
    requested: false,
    transitioning: false,
    resumeSnapshotRequired: false,
    recoveryRequired: false,
  };
}

function sse(events: unknown[]) {
  return new NativeResponse(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
}

/** The Bot's turns. The first asks for help without a word; the run after the hand-back answers as told to. */
function runEvents(input: RunAgentInput): unknown[] {
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
  const answered = input.messages.at(-1)?.role === "tool";
  if (!answered) {
    const call = {
      id: `assistant-${input.runId}`,
      role: "assistant" as const,
      toolCalls: [
        {
          id: "call-help",
          type: "function" as const,
          function: {
            name: "computer_request_help",
            arguments: JSON.stringify({ reason: ASKED }),
          },
        },
      ],
    };
    stored = [...input.messages, call];
    return [
      started,
      {
        type: "TOOL_CALL_START",
        toolCallId: "call-help",
        toolCallName: "computer_request_help",
        parentMessageId: call.id,
      },
      {
        type: "TOOL_CALL_ARGS",
        toolCallId: "call-help",
        delta: JSON.stringify({ reason: ASKED }),
      },
      { type: "TOOL_CALL_END", toolCallId: "call-help" },
      finished,
    ];
  }
  const id = `reply-${input.runId}`;
  stored = [
    ...input.messages,
    ...(replyAfterHandBack
      ? [{ id, role: "assistant" as const, content: replyAfterHandBack }]
      : []),
  ];
  return replyAfterHandBack
    ? [
        started,
        { type: "TEXT_MESSAGE_START", messageId: id, role: "assistant" },
        {
          type: "TEXT_MESSAGE_CONTENT",
          messageId: id,
          delta: replyAfterHandBack,
        },
        { type: "TEXT_MESSAGE_END", messageId: id },
        finished,
      ]
    : [started, finished];
}

/** The computer's control routes, answering as `agent-computer/src/control.ts` does. */
async function computer(path: string, request: Request): Promise<Response> {
  const route = path.replace(`/api/computers/${BOT}`, "");
  if (route === "/control" && request.method === "GET")
    return NativeResponse.json(control);
  if (route === "/control/request") {
    const body = (await request.json()) as {
      reason: string;
      toolCallId?: string;
    };
    control = {
      ...control,
      requested: true,
      reason: body.reason,
      request: {
        id: "request-1",
        ...(body.toolCallId ? { toolCallId: body.toolCallId } : {}),
        reason: body.reason,
        source: "model",
        status: "waiting",
        createdAt: SINCE,
        updatedAt: SINCE,
        expiresAt: "2026-10-28T00:10:00.000Z",
      },
    };
    return NativeResponse.json(control);
  }
  if (route === "/control/take" && control.request) {
    control = {
      ...control,
      holder: "human",
      requested: false,
      heldBy: "user-1",
      request: { ...control.request, status: "taken" },
    };
    return NativeResponse.json(control);
  }
  if (route === "/control/release" && control.request) {
    // The computer's release: the request completed, the wheel back with the Bot, nobody named.
    const { heldBy: _held, reason: _reason, ...rest } = control;
    control = {
      ...rest,
      holder: "bot",
      request: { ...control.request, status: "completed" },
    };
    return NativeResponse.json(control);
  }
  if (route === "/snapshot")
    return NativeResponse.json({
      ok: true,
      snapshotId: 7,
      url: "https://forms.example/order",
      title: "Order",
      elements: [{ ref: "e1", role: "button", name: "Submit order" }],
    });
  if (route === "/screenshot")
    return NativeResponse.json({
      base64: "AAAA",
      width: 1280,
      height: 800,
      capturedAt: SINCE,
      url: "https://forms.example/order",
    });
  if (route === "/status")
    return NativeResponse.json({ botId: BOT, state: "ready" });
  return NativeResponse.json({ error: "Not found" }, { status: 404 });
}

beforeAll(() => {
  GlobalRegistrator.register();
  originalFetch = globalThis.fetch;
  originalDecode = HTMLImageElement.prototype.decode;
  HTMLImageElement.prototype.decode = () => Promise.resolve();
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
      if (url.pathname.startsWith(`/api/computers/${BOT}/`))
        return computer(url.pathname, request);
      if (url.pathname.endsWith("/info"))
        return NativeResponse.json({
          version: "fixture",
          agents: { [BOT]: { description: "Fixture", capabilities: {} } },
          mode: "sse",
          telemetryDisabled: true,
        });
      if (url.pathname.endsWith("/connect"))
        return sse([
          { type: "RUN_STARTED", threadId: channel.threadId, runId: "join" },
          { type: "MESSAGES_SNAPSHOT", messages: stored },
          { type: "RUN_FINISHED", threadId: channel.threadId, runId: "join" },
        ]);
      if (url.pathname.endsWith("/run")) {
        const body = RunAgentInputSchema.parse(await request.json());
        runs.push(body);
        if (body.messages.at(-1)?.role === "tool") await holdAnswer;
        return sse(runEvents(body));
      }
      if (url.pathname.match(/\/threads\/[^/]+\/messages$/))
        return NativeResponse.json({ messages: stored });
      if (url.pathname === "/api/agents")
        return NativeResponse.json({ agents: [] });
      if (url.pathname === `/api/plugins/for/${BOT}`)
        return NativeResponse.json({ skills: [], tools: [] });
      if (url.pathname === "/api/voice/sessions")
        return NativeResponse.json({ sessions: [], nextCursor: null });
      if (/\/api\/channels\/[^/]+\/(activity|busy)$/.test(url.pathname))
        return new NativeResponse(null, { status: 204 });
      // Grants, capabilities, approvals: none of them decides anything here, and the app reads none as a refusal.
      return NativeResponse.json({ error: "Not found" }, { status: 404 });
    },
    { preconnect: () => undefined },
  );
});
beforeEach(() => {
  control = botHolds();
  runs = [];
  stored = [];
  replyAfterHandBack = REPLY;
  holdAnswer = Promise.resolve();
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
            createdAt: SINCE,
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
  HTMLImageElement.prototype.decode = originalDecode;
  globalThis.WebSocket = originalSocket;
  GlobalRegistrator.unregister();
});

/** The signed-in app around one place: the conversation, or anywhere else in the app (Settings, say). */
function app(inConversation: boolean) {
  return (
    <QueryClientProvider client={queryClient}>
      <CopilotKitProvider runtimeUrl="http://localhost/api/copilotkit">
        <ActiveBotProvider>
          <ComputerTools />
          {inConversation ? (
            <ChannelChat channel={channel} runtimeAgentId={BOT} />
          ) : (
            <p>Settings</p>
          )}
        </ActiveBotProvider>
      </CopilotKitProvider>
    </QueryClientProvider>
  );
}

/** Ask the Bot for something it needs the person for, and wait for its request on the computer. */
async function askForHelp(view: ReturnType<typeof render>) {
  const user = userEvent.setup({ document: view.container.ownerDocument });
  await user.type(
    await view.findByRole("textbox", { name: "Message" }),
    "Fill in my phone number on the order form",
  );
  await user.click(view.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(control.request?.status).toBe("waiting"), {
    timeout: 5000,
  });
  return user;
}

/** The tool result the Bot's run after the hand-back carried. */
function handBackResult(): Record<string, unknown> {
  const tool = runs
    .at(-1)
    ?.messages.find(
      (message) =>
        message.role === "tool" && message.toolCallId === "call-help",
    );
  return JSON.parse(String(tool?.content ?? "{}"));
}

test("a help request is drawn in the conversation, and after the hand-back the Bot is told what was done and to carry on", async () => {
  const view = render(app(true));
  const user = await askForHelp(view);
  // While it is open: the Bot's screen, saying what it needs, with the wheel.
  expect(await view.findByText(ASKED, { exact: false })).toBeTruthy();
  await user.click(await view.findByRole("button", { name: "Take control" }));
  await waitFor(() => expect(control.holder).toBe("human"));
  await user.keyboard("{Escape}");
  await user.click(
    await view.findByRole("button", { name: "Hand back" }, { timeout: 3000 }),
  );

  // The Bot's next run carries what happened and asks for the next step said out loud.
  await waitFor(() => expect(runs).toHaveLength(2), { timeout: 5000 });
  const result = handBackResult();
  expect(result).toMatchObject({ ok: true, handoffStatus: "completed" });
  expect(result.result).toBe(
    `A person took control to do what you asked: "${ASKED}" They have finished and handed control back to you, and the snapshot here is the page as they left it. Carry on with the task now. Start your reply by telling the person, in one short sentence, what you are doing next; if nothing is left to do, tell them it is done.`,
  );
  // Read first: the Bot reads what happened before the page.
  expect(Object.keys(result)[0]).toBe("result");

  expect(await view.findByText(REPLY)).toBeTruthy();
  const card = view.container.querySelector('[data-help-request="call-help"]');
  expect(card?.textContent).toBe(
    `Taken over and handed backThe Bot asked: “${ASKED}”`,
  );
  expect(view.queryByRole("button", { name: "Carry on" })).toBeNull();
});

test("a Bot that answers the hand-back with no words leaves a step that says so, and Carry on asks it to go on", async () => {
  replyAfterHandBack = null;
  const view = render(app(true));
  const user = await askForHelp(view);
  // Handed back on the computer (from the Bot's screen in the side panel, say).
  const { reason: _reason, ...rest } = control;
  control = {
    ...rest,
    request: {
      ...(control.request as NonNullable<typeof control.request>),
      status: "completed",
    },
  };
  await waitFor(() => expect(runs).toHaveLength(2), { timeout: 5000 });

  await waitFor(() =>
    expect(
      view.container.querySelector('[data-help-request="call-help"]')
        ?.textContent,
    ).toBe(
      `Taken over and handed backThe Bot asked: “${ASKED}” The Bot stopped here without saying what it does next.Carry on`,
    ),
  );
  await user.click(view.getByRole("button", { name: "Carry on" }));
  await waitFor(() => expect(runs).toHaveLength(3));
  expect(runs[2]?.messages.at(-1)).toMatchObject({
    role: "user",
    content: "Please carry on.",
  });
});

test("leaving the conversation while holding control: back in it, the hand-back's reply shows without a reload, and nothing offers to resume", async () => {
  const view = render(app(true));
  await askForHelp(view);
  // The person takes the wheel (in the Bot's screen) and goes elsewhere in the app while holding it.
  control = {
    ...control,
    holder: "human",
    requested: false,
    heldBy: "user-1",
    request: {
      ...(control.request as NonNullable<typeof control.request>),
      status: "taken",
    },
  };
  view.rerender(app(false));
  await view.findByText("Settings");

  // Back in the conversation: a new chat, which restores the thread as stored, the help call still unanswered.
  view.rerender(app(true));
  const user = userEvent.setup({ document: view.container.ownerDocument });
  let release = () => {};
  holdAnswer = new Promise((resolve) => {
    release = resolve;
  });
  await user.click(
    await view.findByRole("button", { name: "Hand back" }, { timeout: 5000 }),
  );
  // The waiting call has its answer and the Bot is working on it: nothing here is paused, and the step says so.
  await waitFor(() => expect(runs).toHaveLength(2), { timeout: 5000 });
  await new Promise((resolve) => setTimeout(resolve, 1500));
  expect(view.queryByText(/A browser task is paused/)).toBeNull();
  expect(view.queryByRole("button", { name: "Resume task" })).toBeNull();
  expect(
    view.container.querySelector('[data-help-request="call-help"]')
      ?.textContent,
  ).toBe(
    `Taken over and handed backThe Bot asked: “${ASKED}” The Bot is carrying on.`,
  );
  release();

  // The turn that was waiting carries on with the answer; its reply reaches the conversation on screen.
  expect(await view.findByText(REPLY, {}, { timeout: 6000 })).toBeTruthy();
  expect(handBackResult()).toMatchObject({ handoffStatus: "completed" });
  // And nothing claims a task is paused: it was not, and Resume would run it again.
  await new Promise((resolve) => setTimeout(resolve, 1500));
  expect(view.queryByText(/A browser task is paused/)).toBeNull();
  expect(view.queryByRole("button", { name: "Resume task" })).toBeNull();
  expect(runs).toHaveLength(2);
});
