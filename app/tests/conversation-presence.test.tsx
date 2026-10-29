import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import type { Message } from "@ag-ui/core";
import { CopilotKitProvider } from "@copilotkit/react-core/v2";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  type InfiniteData,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type ReactNode, useState } from "react";
import { ChannelChat } from "@/components/channels/channel-chat";
import { Composer } from "@/components/channels/composer/composer";
import {
  ConversationPresenceProvider,
  ConversationStatusLine,
  useConversationOrb,
} from "@/components/channels/conversation-presence";
import { ConversationView } from "@/components/channels/conversation-view";
import type { AgentProfile } from "@/lib/agents/queries";
import type { ApprovalInboxData } from "@/lib/approvals";
import {
  type AgentChannel,
  type ChannelPage,
  type ChannelSummary,
  channelKeys,
} from "@/lib/channels/queries";
import { THINKING } from "@/lib/channels/step";
import { queryClient } from "@/query-client";
import { settleReactWork } from "./settle-react-work";

/**
 * A conversation with one Bot shows that Bot's orb in its header, with a line under the name: the
 * orb works while the Bot has the turn and listens while the person types; the line says "Working"
 * and the step, or "Needs you" while an approval waits there, and nothing at rest. The conversation
 * list's busy flag counts as working too, so a run the server resumes after Allow once still shows.
 */

const originalFetch = globalThis.fetch;
beforeAll(() => GlobalRegistrator.register({ url: "http://localhost/" }));
// Nothing here is served unless a test says so: what the header reads is seeded into the cache.
beforeEach(() => {
  globalThis.fetch = Object.assign(
    async () => Response.json({ error: "not served" }, { status: 404 }),
    { preconnect: originalFetch.preconnect },
  );
});
afterEach(() => {
  cleanup();
  queryClient.clear();
  globalThis.fetch = originalFetch;
});
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const CHANNEL = "c-1";
const THREAD = "t-1";

const asked = (id: string, content: string): Message => ({
  id,
  role: "user",
  content,
});
function searching(result?: string): Message[] {
  const call: Message = {
    id: "s-call",
    role: "assistant",
    content: "",
    toolCalls: [
      {
        id: "s",
        type: "function",
        function: {
          name: "mcp__exa__web_search_exa",
          arguments: JSON.stringify({ query: "Q3 budget" }),
        },
      },
    ],
  };
  return result === undefined
    ? [call]
    : [
        call,
        { id: "s-result", role: "tool", toolCallId: "s", content: result },
      ];
}
const RUNNING = [asked("u1", "What changed?"), ...searching()];
const ANSWERED = [asked("u1", "What changed?"), ...searching('"Results"')];

function summary(busy: boolean): ChannelSummary {
  return {
    id: CHANNEL,
    name: "Q3 budget",
    agentIds: ["ana"],
    threadId: THREAD,
    active: true,
    lastMessageAt: null,
    summary: null,
    lastMessage: null,
    lastMessageAgentId: null,
    createdAt: "2026-10-28T00:00:00.000Z",
    pinned: false,
    lastReadAt: null,
    busy,
  };
}
function listOf(busy: boolean): InfiniteData<ChannelPage> {
  return {
    pages: [{ channels: [summary(busy)], nextCursor: null }],
    pageParams: [""],
  };
}
function inboxWith(
  requests: { threadId: string; status: string }[],
): ApprovalInboxData {
  return {
    enabled: true,
    requests: requests.map(({ threadId, status }, index) => ({
      id: `r-${index}`,
      status,
      createdAt: "2026-10-28T00:00:00.000Z",
      action: {
        botId: "ana",
        toolRef: "google-workspace/gmail_send_reply",
        effect: "write",
        scope: "external",
        threadId,
        toolCallId: `call-${index}`,
        args: {},
        target: {},
      },
    })),
    rules: [],
    teamRules: [],
    questions: [],
  };
}

/** The header's orb state, read as the header's orb reads it. */
function OrbProbe() {
  return <output data-probe="orb">{useConversationOrb()}</output>;
}

/**
 * The route's presence with the header's two readers and whatever `show` puts under them, so
 * swapping the conversation changes that and nothing else.
 */
function renderConversation(
  first: ReactNode,
  {
    busy = false,
    inbox = inboxWith([]),
  }: { busy?: boolean; inbox?: ApprovalInboxData } = {},
) {
  let show: (screen: ReactNode) => void = () => {};
  function Screen() {
    const [screen, setScreen] = useState(first);
    show = setScreen;
    return screen;
  }
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  client.setQueryData(channelKeys.list(), listOf(busy));
  client.setQueryData(["approvals"], inbox);
  // The transcript draws a lone tool call through CopilotKit, so the conversation needs its provider.
  const view = render(
    <QueryClientProvider client={client}>
      <CopilotKitProvider>
        <ConversationPresenceProvider channelId={CHANNEL} threadId={THREAD}>
          <OrbProbe />
          <ConversationStatusLine />
          <Screen />
        </ConversationPresenceProvider>
      </CopilotKitProvider>
    </QueryClientProvider>,
  );
  return {
    view,
    show: (screen: ReactNode) => act(() => show(screen)),
    // The cache tells its readers on a timer of its own, so the update is waited out.
    setBusy: (next: boolean) =>
      act(async () => {
        client.setQueryData(channelKeys.list(), listOf(next));
        await new Promise((resolve) => setTimeout(resolve, 0));
      }),
    line: () =>
      view.container.querySelector("[aria-live='polite']")?.textContent ?? null,
    orb: () =>
      view.container.querySelector("[data-probe='orb']")?.textContent ?? null,
  };
}

function Chat({
  busy = false,
  messages,
  stopped,
}: {
  busy?: boolean;
  messages: Message[];
  stopped?: string;
}) {
  return (
    <ConversationView
      busy={busy}
      channelId={CHANNEL}
      messages={messages}
      onSubmit={() => {}}
      pending={busy}
      {...(stopped ? { stopped } : {})}
    />
  );
}

describe("the header's orb and the line under the name", () => {
  test("rest with nothing to say, in a live region that is already there", () => {
    const { view, line, orb } = renderConversation(
      <Chat messages={ANSWERED} />,
    );
    expect(view.container.querySelector("[aria-live='polite']")).not.toBeNull();
    expect(line()).toBe("");
    expect(orb()).toBe("idle");
  });

  test("say Working and the step while the Bot works, and nothing once the turn is over", () => {
    const { show, line, orb } = renderConversation(
      <Chat busy messages={RUNNING} />,
    );
    expect(line()).toBe("Working · Searching the web");
    expect(orb()).toBe("thinking");

    show(<Chat busy messages={ANSWERED} />);
    expect(line()).toBe(`Working · ${THINKING}`);

    show(<Chat messages={ANSWERED} />);
    expect(line()).toBe("");
    // An answer lands before the orb rests.
    expect(orb()).toBe("done");
  });

  test("a stopped turn does not land", () => {
    const { show, orb } = renderConversation(<Chat busy messages={RUNNING} />);
    show(<Chat messages={RUNNING} stopped="You stopped this." />);
    expect(orb()).toBe("idle");
  });

  test("a turn that ends on a call held for the person does not land", () => {
    // The server holds the search for the person: the turn ends with the call and no result.
    const held = renderConversation(<Chat busy messages={RUNNING} />);
    held.show(<Chat messages={RUNNING} />);
    expect(held.orb()).toBe("idle");
    cleanup();

    // The browser sends a click to its card, stops the run, and notes that it went there.
    const clicking = (result?: string): Message[] => [
      asked("u1", "Pay the invoice"),
      {
        id: "c-call",
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "click",
            type: "function",
            function: {
              name: "computer_click",
              arguments: JSON.stringify({ ref: "e1" }),
            },
          },
        ],
      },
      ...(result === undefined
        ? []
        : [
            {
              id: "c-result",
              role: "tool" as const,
              toolCallId: "click",
              content: result,
            },
          ]),
    ];
    const sent = renderConversation(<Chat busy messages={clicking()} />);
    sent.show(<Chat messages={clicking(JSON.stringify({ waiting: true }))} />);
    expect(sent.orb()).toBe("idle");
  });

  test("Needs you holds off the landing of a turn that did answer", () => {
    const { show, line, orb } = renderConversation(
      <Chat busy messages={RUNNING} />,
      { inbox: inboxWith([{ threadId: THREAD, status: "pending" }]) },
    );
    show(<Chat messages={ANSWERED} />);
    expect(line()).toBe("Needs you");
    expect(orb()).toBe("idle");
  });

  test("say Needs you while an approval waits in this conversation, and only this one", () => {
    const waiting = renderConversation(<Chat messages={ANSWERED} />, {
      inbox: inboxWith([{ threadId: THREAD, status: "pending" }]),
    });
    expect(waiting.line()).toBe("Needs you");
    cleanup();

    const elsewhere = renderConversation(<Chat messages={ANSWERED} />, {
      inbox: inboxWith([
        { threadId: "another-thread", status: "pending" },
        { threadId: THREAD, status: "approved" },
      ]),
    });
    expect(elsewhere.line()).toBe("");
  });

  test("Needs you comes before the step the Bot is on", () => {
    const { line } = renderConversation(<Chat busy messages={RUNNING} />, {
      inbox: inboxWith([{ threadId: THREAD, status: "pending" }]),
    });
    expect(line()).toBe("Needs you");
  });

  test("a run the server resumed after Allow once still shows as working", async () => {
    const { line, orb, setBusy } = renderConversation(
      <Chat messages={ANSWERED} />,
      { busy: true },
    );
    expect(line()).toBe("Working");
    expect(orb()).toBe("thinking");

    await setBusy(false);
    expect(line()).toBe("");
    expect(orb()).toBe("idle");
  });

  test("the busy flag of the conversation's own turn does not outlast the turn", async () => {
    const { show, line, setBusy } = renderConversation(
      <Chat busy messages={RUNNING} />,
      { busy: true },
    );
    expect(line()).toBe("Working · Searching the web");

    // The turn is over here a moment before the server's flag comes down.
    show(<Chat messages={ANSWERED} />);
    expect(line()).toBe("");
    await setBusy(false);
    expect(line()).toBe("");

    // A run the server starts afterwards is its own, and shows.
    await setBusy(true);
    expect(line()).toBe("Working");
  });

  test("a busy spell this tab owned in one conversation does not hide the next one's", () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    // Both conversations are busy: this tab's own turn in the first, the server in the second.
    client.setQueryData(channelKeys.list(), {
      pages: [
        {
          channels: [summary(true), { ...summary(true), id: "c-2" }],
          nextCursor: null,
        },
      ],
      pageParams: [""],
    });
    client.setQueryData(["approvals"], inboxWith([]));
    let open: (channelId: string) => void = () => {};
    function Route() {
      const [channelId, setChannelId] = useState(CHANNEL);
      open = setChannelId;
      return (
        <ConversationPresenceProvider channelId={channelId} threadId={THREAD}>
          <ConversationStatusLine />
          {channelId === CHANNEL ? <Chat busy messages={RUNNING} /> : null}
        </ConversationPresenceProvider>
      );
    }
    const view = render(
      <QueryClientProvider client={client}>
        <CopilotKitProvider>
          <Route />
        </CopilotKitProvider>
      </QueryClientProvider>,
    );
    const line = () =>
      view.container.querySelector("[aria-live='polite']")?.textContent;
    expect(line()).toBe("Working · Searching the web");

    act(() => open("c-2"));
    expect(line()).toBe("Working");
  });

  test("the orb listens while the person types, and rests when the box is empty again", async () => {
    const { view, orb, line } = renderConversation(
      <Chat messages={ANSWERED} />,
    );
    const user = userEvent.setup({ document: view.container.ownerDocument });
    const box = view.getByRole("textbox", { name: "Message" });
    await user.type(box, "One more thing");
    await waitFor(() => expect(orb()).toBe("listening"));
    expect(line()).toBe("");

    await user.clear(box);
    await waitFor(() => expect(orb()).toBe("idle"));
  });

  test("leaving the conversation mid-turn rests the orb and empties the line", () => {
    const { show, line, orb } = renderConversation(
      <Chat busy messages={RUNNING} />,
    );
    expect(orb()).toBe("thinking");
    show(null);
    expect(line()).toBe("");
    expect(orb()).toBe("idle");
  });
});

describe("the composer's placeholder", () => {
  test("names the Bot it was given, and otherwise keeps its own", () => {
    const named = render(
      <ConversationView
        messages={[]}
        onSubmit={() => {}}
        placeholder="Message Ana"
      />,
    );
    expect(named.getByText("Message Ana")).toBeTruthy();
    cleanup();

    for (const compact of [true, false]) {
      const plain = render(<Composer compact={compact} onSubmit={() => {}} />);
      expect(plain.getByText("Ask anything")).toBeTruthy();
      cleanup();
    }
  });
});

/*
 * A real conversation with one Bot, drawn as the route draws it under its header, against a server
 * that answers just enough for it to mount.
 */
describe("a conversation with one Bot", () => {
  const ANA: AgentProfile = {
    id: "ana",
    name: "Ana",
    title: "Research",
    roleDescription: "Looks things up.",
    avatarSeed: "ana",
    visibility: "private",
    endpoint: null,
    builtIn: true,
    hasAuth: false,
    hasCallbackToken: false,
    isolated: false,
    isolationActive: false,
    isolationOffReason: null,
    hidden: false,
    pinned: false,
    systemOwned: false,
    canManage: true,
    mine: true,
  };
  const channel: AgentChannel = {
    id: CHANNEL,
    name: "Q3 budget",
    agentIds: ["ana"],
    threadId: THREAD,
    active: true,
    lastMessageAt: null,
  };
  const NativeResponse = globalThis.Response;
  const sse = (events: unknown[]) =>
    new NativeResponse(
      events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
      { headers: { "content-type": "text/event-stream" } },
    );
  async function served(input: Parameters<typeof fetch>[0]) {
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
      "http://localhost",
    );
    if (url.pathname === "/api/agents")
      return NativeResponse.json({ agents: [ANA] });
    if (url.pathname === "/api/plugins/for/ana")
      return NativeResponse.json({ skills: [], tools: [] });
    if (url.pathname.endsWith("/info"))
      return NativeResponse.json({
        version: "fixture",
        agents: { ana: { description: "Fixture", capabilities: {} } },
        mode: "sse",
        telemetryDisabled: true,
      });
    if (url.pathname.endsWith("/connect"))
      return sse([
        { type: "RUN_STARTED", threadId: THREAD, runId: "join" },
        { type: "MESSAGES_SNAPSHOT", messages: [] },
        { type: "RUN_FINISHED", threadId: THREAD, runId: "join" },
      ]);
    if (url.pathname.endsWith(`/threads/${THREAD}/messages`))
      return NativeResponse.json({ messages: [] });
    if (url.pathname === "/api/voice/sessions")
      return NativeResponse.json({ sessions: [], nextCursor: null });
    if (url.pathname === "/api/approvals")
      return NativeResponse.json(inboxWith([]));
    return NativeResponse.json({ error: "not served" }, { status: 404 });
  }

  test("asks for a message to the Bot by name, and its orb listens while the person types", async () => {
    globalThis.fetch = Object.assign(served, {
      preconnect: originalFetch.preconnect,
    });
    queryClient.setQueryData(channelKeys.list(), listOf(false));
    const view = render(
      <QueryClientProvider client={queryClient}>
        <CopilotKitProvider runtimeUrl="http://localhost/api/copilotkit">
          <ConversationPresenceProvider channelId={CHANNEL} threadId={THREAD}>
            <OrbProbe />
            <ChannelChat channel={channel} runtimeAgentId="ana" />
          </ConversationPresenceProvider>
        </CopilotKitProvider>
      </QueryClientProvider>,
    );
    expect(await view.findByText("Message Ana")).toBeTruthy();
    const orb = () =>
      view.container.querySelector("[data-probe='orb']")?.textContent;
    expect(orb()).toBe("idle");

    const user = userEvent.setup({ document: view.container.ownerDocument });
    await user.type(
      view.getByRole("textbox", { name: "Message" }),
      "Is the budget final?",
    );
    await waitFor(() => expect(orb()).toBe("listening"));
  });
});
