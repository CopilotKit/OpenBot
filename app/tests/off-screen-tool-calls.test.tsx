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
import { GALLERY as CARDS } from "@/components/gallery/cards";
import {
  type AgentChannel,
  type ChannelPage,
  type ChannelSummary,
  channelKeys,
} from "@/lib/channels/queries";
import { ActiveBotProvider } from "@/lib/copilot/active-bot";
import { ComputerTools } from "@/lib/copilot/computer-tools";
import { GALLERY_COMPONENTS } from "@/lib/copilot/gallery-registry";
import { GalleryTools } from "@/lib/copilot/gallery-tools";
import { SignInTool } from "@/lib/copilot/sign-in-tool";
import { queryClient } from "@/query-client";
import { settleReactWork } from "./settle-react-work";

/**
 * A tool call that arrives after its person has left the conversation acts for the Bot that made it.
 *
 * The provider is app-wide, so a turn the person walks away from keeps going, and the calls it makes
 * are handled while another screen is in front of them. The handlers used to ask the screen which Bot
 * they were acting for. A record a Bot drew while its person was elsewhere in the app was checked
 * against the placeholder Bot, which the server does not know, and the person came back to "Not
 * shown: Record. This deployment could not be asked whether that component is allowed" where the
 * record should have been. In another Bot's conversation the check was made for that other Bot.
 *
 * End to end in the app, as `help-handback.test.tsx` is: the real chat, the real tools and the
 * CopilotKit core running them, against a runtime and a server that answer as the real ones do. The
 * Bot's run is held until the person has gone, then streams its one call.
 */

const BOT = "crm-bot";
const OTHER = "other-bot";
const channel: AgentChannel = {
  id: "crm-channel",
  name: "Accounts",
  agentIds: [BOT],
  threadId: "crm-thread",
  active: true,
  lastMessageAt: "2026-11-03T00:00:00.000Z",
};
const otherChannel: AgentChannel = {
  id: "other-channel",
  name: "Something else",
  agentIds: [OTHER],
  threadId: "other-thread",
  active: true,
  lastMessageAt: "2026-11-03T00:00:00.000Z",
};
const NativeResponse = globalThis.Response;

/*
 * The real Record card, registered as Vite would have registered it. `import.meta.glob` is Vite's,
 * so under `bun test` the registry finds no gallery modules and `GalleryTools` registers nothing.
 * Taken off again in `afterAll`, so no other file sees it.
 */
function theRecordCard() {
  const spec = CARDS.find((candidate) => candidate.name === "showRecord");
  if (!spec?.confirmation)
    throw new Error(
      "The Record card, with what the Bot is told, is not in the gallery.",
    );
  return { ...spec, confirmation: spec.confirmation };
}
const RECORD = theRecordCard();
const RECORD_ARGS = {
  title: "Northwind Traders",
  subtitle: "Enterprise account",
  status: "Renewal due",
  fields: [{ label: "Owner", value: "Priya Raman" }],
};

/** What the Bot's held run streams once the person has gone: one call, with these arguments. */
let call: { name: string; args: Record<string, unknown> };
let runs: RunAgentInput[] = [];
/** The thread as the runtime has stored it. */
let stored: Message[] = [];
/** Holds the Bot's first run until the test lets its call arrive. */
let arrive: Promise<void> = Promise.resolve();
/** Every question asked of `/api/components/:name/decision`, as its body. */
let decisions: unknown[] = [];
/** Every computer route called, as its path. */
let computerCalls: string[] = [];
/** Every sign-in request opened, as its body. */
let signIns: unknown[] = [];
let originalFetch: typeof fetch;
let originalDecode: typeof HTMLImageElement.prototype.decode;
let originalSocket: typeof WebSocket;

/** The live screen's socket, which nothing here answers. */
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

function sse(events: unknown[]) {
  return new NativeResponse(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
}

const CALL_ID = "call-off-screen";
const REPLY = "Done.";

/** The Bot's turns: the first makes the call, the one after its result says it is done. */
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
  if (input.messages.at(-1)?.role !== "tool") {
    const assistant = {
      id: `assistant-${input.runId}`,
      role: "assistant" as const,
      toolCalls: [
        {
          id: CALL_ID,
          type: "function" as const,
          function: { name: call.name, arguments: JSON.stringify(call.args) },
        },
      ],
    };
    stored = [...input.messages, assistant];
    return [
      started,
      {
        type: "TOOL_CALL_START",
        toolCallId: CALL_ID,
        toolCallName: call.name,
        parentMessageId: assistant.id,
      },
      {
        type: "TOOL_CALL_ARGS",
        toolCallId: CALL_ID,
        delta: JSON.stringify(call.args),
      },
      { type: "TOOL_CALL_END", toolCallId: CALL_ID },
      finished,
    ];
  }
  const id = `reply-${input.runId}`;
  stored = [...input.messages, { id, role: "assistant", content: REPLY }];
  return [
    started,
    { type: "TEXT_MESSAGE_START", messageId: id, role: "assistant" },
    { type: "TEXT_MESSAGE_CONTENT", messageId: id, delta: REPLY },
    { type: "TEXT_MESSAGE_END", messageId: id },
    finished,
  ];
}

/**
 * The server's component routes, answering as `server/src/components/routes.ts` does: an id that is
 * not a Bot this person can use is a 404, and a Bot is allowed only what it holds.
 */
async function components(path: string, request: Request): Promise<Response> {
  if (path === "/api/components/catalogue")
    return NativeResponse.json({ added: [] });
  if (path === `/api/components/for-agent/${BOT}`)
    return NativeResponse.json({
      components: [{ name: "showRecord", description: RECORD.description }],
    });
  if (path === `/api/components/for-agent/${OTHER}`)
    return NativeResponse.json({ components: [] });
  if (path === "/api/components/showRecord/decision") {
    const body = (await request.json()) as { agentId?: string };
    decisions.push(body);
    if (body.agentId === BOT) return NativeResponse.json({ allowed: true });
    if (body.agentId === OTHER)
      return NativeResponse.json({
        allowed: false,
        reason: "Record is not available to this Bot at the moment.",
      });
    return NativeResponse.json(
      { error: "There is no such Bot." },
      { status: 404 },
    );
  }
  return NativeResponse.json({ error: "Not found" }, { status: 404 });
}

/** A Bot's computer. Only the crm Bot's answers; any other id is a computer that is not there. */
function computer(path: string): Response {
  computerCalls.push(path);
  if (path === `/api/computers/${BOT}/navigate`)
    return NativeResponse.json({
      ok: true,
      url: "https://crm.example/accounts/northwind",
      title: "Northwind Traders",
      text: "Northwind Traders. Renewal due.",
    });
  if (path === `/api/computers/${BOT}/status`)
    return NativeResponse.json({ botId: BOT, state: "ready" });
  return NativeResponse.json({ error: "Not found" }, { status: 404 });
}

/** The sign-in routes: the request opens, and is already signed in the first time it is read. */
async function signIn(path: string, request: Request): Promise<Response> {
  const opened = {
    id: "sign-in-1",
    botId: BOT,
    origin: "https://crm.example",
    reason: null,
    status: "pending",
    method: null,
    outcome: null,
    threadId: null,
    toolCallId: CALL_ID,
    controlRequestId: null,
    createdAt: "2026-11-03T00:00:00Z",
    expiresAt: "2026-11-03T00:15:00Z",
    resolvedAt: null,
    passwordManager: false,
    savedLogins: [],
  };
  if (path === "/api/sign-in-requests" && request.method === "POST") {
    const body = (await request.json()) as { botId?: string };
    signIns.push(body);
    if (body.botId !== BOT)
      return NativeResponse.json(
        { error: "There is no such Bot." },
        { status: 404 },
      );
    return NativeResponse.json(opened, { status: 201 });
  }
  if (path === "/api/sign-in-requests")
    return NativeResponse.json({ requests: [] });
  if (path === "/api/sign-in-requests/sign-in-1")
    return NativeResponse.json({ ...opened, status: "signed_in" });
  return NativeResponse.json({ error: "Not found" }, { status: 404 });
}

beforeAll(() => {
  GALLERY_COMPONENTS.push(RECORD);
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
      if (url.pathname.startsWith("/api/computers/"))
        return computer(url.pathname);
      if (url.pathname.startsWith("/api/components/"))
        return components(url.pathname, request);
      if (url.pathname.startsWith("/api/sign-in-requests"))
        return signIn(url.pathname, request);
      if (url.pathname.endsWith("/info"))
        return NativeResponse.json({
          version: "fixture",
          agents: {
            [BOT]: { description: "Fixture", capabilities: {} },
            [OTHER]: { description: "Fixture", capabilities: {} },
          },
          mode: "sse",
          telemetryDisabled: true,
        });
      if (url.pathname.endsWith("/connect")) {
        const { threadId } = (await request.json()) as { threadId: string };
        return sse([
          { type: "RUN_STARTED", threadId, runId: "join" },
          {
            type: "MESSAGES_SNAPSHOT",
            messages: threadId === channel.threadId ? stored : [],
          },
          { type: "RUN_FINISHED", threadId, runId: "join" },
        ]);
      }
      if (url.pathname.endsWith("/run")) {
        const body = RunAgentInputSchema.parse(await request.json());
        runs.push(body);
        if (body.messages.at(-1)?.role !== "tool") await arrive;
        return sse(runEvents(body));
      }
      if (url.pathname === `/api/threads/${channel.threadId}/messages`)
        return NativeResponse.json({ messages: stored });
      if (url.pathname.match(/\/threads\/[^/]+\/messages$/))
        return NativeResponse.json({ messages: [] });
      if (url.pathname === "/api/agents")
        return NativeResponse.json({ agents: [] });
      if (/^\/api\/plugins\/for\/[^/]+$/.test(url.pathname))
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
  decisions = [];
  computerCalls = [];
  signIns = [];
  arrive = Promise.resolve();
  sessionStorage.clear();
  queryClient.clear();
  const summary = (entry: AgentChannel): ChannelSummary => ({
    ...entry,
    summary: null,
    lastMessage: null,
    lastMessageAgentId: null,
    createdAt: "2026-11-03T00:00:00.000Z",
    pinned: false,
    lastReadAt: null,
  });
  queryClient.setQueryData<InfiniteData<ChannelPage>>(channelKeys.list(), {
    pages: [
      {
        channels: [summary(channel), summary(otherChannel)],
        nextCursor: null,
      },
    ],
    pageParams: [""],
  });
});
afterEach(() => cleanup());
afterAll(async () => {
  await settleReactWork();
  GALLERY_COMPONENTS.splice(GALLERY_COMPONENTS.indexOf(RECORD), 1);
  globalThis.fetch = originalFetch;
  HTMLImageElement.prototype.decode = originalDecode;
  globalThis.WebSocket = originalSocket;
  GlobalRegistrator.unregister();
});

type Place = "conversation" | "elsewhere" | "another Bot";

/** The signed-in app around one place: the crm Bot's conversation, a page with none, or another Bot's. */
function app(place: Place) {
  return (
    <QueryClientProvider client={queryClient}>
      <CopilotKitProvider runtimeUrl="http://localhost/api/copilotkit">
        <ActiveBotProvider>
          <ComputerTools />
          <SignInTool />
          <GalleryTools />
          {place === "conversation" ? (
            <ChannelChat
              channel={channel}
              key={channel.id}
              runtimeAgentId={BOT}
            />
          ) : place === "another Bot" ? (
            <ChannelChat
              channel={otherChannel}
              key={otherChannel.id}
              runtimeAgentId={OTHER}
            />
          ) : (
            <p>Settings</p>
          )}
        </ActiveBotProvider>
      </CopilotKitProvider>
    </QueryClientProvider>
  );
}

/**
 * Ask the crm Bot for something, go to `place` while it is working, and only then let its call
 * arrive. Resolves once the Bot's next run, the one carrying the call's result, has been asked for.
 */
async function leaveBeforeTheCall(place: Place) {
  let release = () => {};
  arrive = new Promise((resolve) => {
    release = resolve;
  });
  const view = render(app("conversation"));
  const user = userEvent.setup({ document: view.container.ownerDocument });
  await user.type(
    await view.findByRole("textbox", { name: "Message" }),
    "Pull up Northwind",
  );
  await user.click(view.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(runs).toHaveLength(1), { timeout: 5000 });

  view.rerender(app(place));
  if (place === "elsewhere") await view.findByText("Settings");
  else
    await waitFor(() =>
      expect(view.queryByRole("textbox", { name: "Message" })).toBeTruthy(),
    );
  release();
  await waitFor(() => expect(runs).toHaveLength(2), { timeout: 5000 });
  return view;
}

/** What the Bot was told the call came to, from the run that carried it. */
function result(): string {
  const message = runs
    .at(-1)
    ?.messages.find(
      (candidate) =>
        candidate.role === "tool" && candidate.toolCallId === CALL_ID,
    );
  return String(message?.content ?? "");
}

test("a record the Bot draws after its person has left the conversation is checked for that Bot, and is there when they come back", async () => {
  call = { name: "showRecord", args: RECORD_ARGS };
  const view = await leaveBeforeTheCall("elsewhere");

  expect(decisions).toEqual([{ agentId: BOT, functions: [] }]);
  expect(result()).toBe(RECORD.confirmation);

  // Back in the conversation: the record, not "Not shown: Record".
  view.rerender(app("conversation"));
  expect(
    await view.findByText("Enterprise account", {}, { timeout: 5000 }),
  ).toBeTruthy();
  expect(view.queryByTestId("component-refused")).toBeNull();
});

test("a record the Bot draws while its person is in another Bot's conversation is checked for the Bot that drew it", async () => {
  call = { name: "showRecord", args: RECORD_ARGS };
  await leaveBeforeTheCall("another Bot");

  expect(decisions).toEqual([{ agentId: BOT, functions: [] }]);
  expect(result()).toBe(RECORD.confirmation);
});

test("a page the Bot opens after its person has left is opened on that Bot's computer", async () => {
  call = {
    name: "computer_navigate",
    args: { url: "https://crm.example/accounts/northwind" },
  };
  await leaveBeforeTheCall("elsewhere");

  expect(computerCalls).toContain(`/api/computers/${BOT}/navigate`);
  expect(
    computerCalls.filter((path) => !path.startsWith(`/api/computers/${BOT}/`)),
  ).toEqual([]);
  expect(JSON.parse(result())).toMatchObject({
    ok: true,
    title: "Northwind Traders",
  });
});

test("a sign-in the Bot asks for from another Bot's conversation is opened for the Bot that asked", async () => {
  call = {
    name: "computer_request_sign_in",
    args: { site: "https://crm.example" },
  };
  await leaveBeforeTheCall("another Bot");

  expect(signIns).toEqual([
    expect.objectContaining({ botId: BOT, site: "https://crm.example" }),
  ]);
  expect(JSON.parse(result())).toMatchObject({ ok: true, signedIn: true });
});
