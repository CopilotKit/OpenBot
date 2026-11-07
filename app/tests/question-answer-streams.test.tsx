import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
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
  channelKeys,
} from "@/lib/channels/queries";
import { queryClient } from "@/query-client";

/**
 * The Bot asked the person a question in their conversation ("Which city?"), and they answered it
 * there ("Chicago"). The Bot's work on that answer streams in the conversation as it happens, and
 * Stop stops it, like any turn.
 *
 * It used to be handed to the server to resume out of sight: the screen said "reading your answer"
 * for as long as the whole turn took, with no steps and no Stop, and then drew every step at once.
 *
 * The runtime and the approvals routes are played at the HTTP boundary, the way they behave
 * (`server/tests/question-answer-in-conversation.integration.test.ts` holds the server to its half).
 * Everything above it is the real provider, the real ChannelChat and the real transcript.
 */

type ChannelCache = InfiniteData<ChannelPage>;
const NativeResponse = globalThis.Response;
const BOT = "picked-harness";
const channel: AgentChannel = {
  id: "weekend-channel",
  name: "Personal Assistant",
  agentIds: [BOT],
  threadId: "weekend-thread",
  active: true,
  lastMessageAt: "2026-11-06T00:00:00.000Z",
};
const QUESTION = "Which city should I look for weekend plans in?";
const ASKED: Message[] = [
  { id: "person", role: "user", content: "Find weekend plans" },
  {
    id: "asks",
    role: "assistant",
    content: "",
    toolCalls: [
      {
        id: "ask-call",
        type: "function",
        function: {
          name: "ask_person",
          arguments: JSON.stringify({ question: QUESTION }),
        },
      },
    ],
  },
  {
    id: "asked",
    role: "tool",
    toolCallId: "ask-call",
    content:
      "Put to the person in the source conversation; the question is saved awaiting their reply",
  },
];
const WORKING = "Looking up what's on in Chicago this weekend";

let originalFetch: typeof fetch;
let open = true;
let answers: unknown[] = [];
let runs: RunAgentInput[] = [];
let stopRequests: string[] = [];
let finishRun: (() => void) | null = null;

function frames(events: unknown[]) {
  return events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
}

/** A run that streams the start of its work and waits, as a Bot still working does. */
function run(input: RunAgentInput): Response {
  runs.push(input);
  const messageId = `reply-${input.runId}`;
  const opening = [
    { type: "RUN_STARTED", threadId: input.threadId, runId: input.runId },
    { type: "TEXT_MESSAGE_START", messageId, role: "assistant" },
    { type: "TEXT_MESSAGE_CONTENT", messageId, delta: WORKING },
  ];
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      controller.enqueue(encoder.encode(frames(opening)));
      finishRun = () => {
        finishRun = null;
        controller.enqueue(
          encoder.encode(
            frames([
              { type: "TEXT_MESSAGE_END", messageId },
              {
                type: "RUN_FINISHED",
                threadId: input.threadId,
                runId: input.runId,
                outcome: { type: "cancelled" },
              },
            ]),
          ),
        );
        controller.close();
      };
    },
  });
  return new NativeResponse(body, {
    headers: { "content-type": "text/event-stream" },
  });
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
      const request = () =>
        input instanceof Request ? input : new Request(url, init);
      if (url.pathname === "/api/agents")
        return NativeResponse.json({ agents: [] });
      if (url.pathname === `/api/plugins/for/${BOT}`)
        return NativeResponse.json({ skills: [], tools: [] });
      if (url.pathname === `/api/agents/${BOT}`)
        return NativeResponse.json({
          agent: { id: BOT, visibility: "public", canManage: true },
        });
      if (url.pathname === `/api/components/for-agent/${BOT}`)
        return NativeResponse.json({ components: [] });
      if (url.pathname === "/api/admin/enterprise/me")
        return NativeResponse.json({ capabilities: {}, enforced: false });
      // The question the Bot is waiting on, in this conversation, until it is answered.
      if (url.pathname === "/api/approvals")
        return NativeResponse.json({
          enabled: true,
          requests: [],
          rules: [],
          teamRules: [],
          questions: open
            ? [
                {
                  id: "q-1",
                  botId: BOT,
                  conversationBotId: BOT,
                  threadId: channel.threadId,
                  channelId: channel.id,
                  question: QUESTION,
                  createdAt: "2026-11-06T00:00:00.000Z",
                },
              ]
            : [],
        });
      /*
       * As the server answers it: a question the person's own turn asked, answered in its
       * conversation, is closed and left to that conversation to run. Anything else is queued.
       */
      if (url.pathname === "/api/approvals/questions/q-1/respond") {
        const body = (await request().json()) as { inConversation?: boolean };
        answers.push(body);
        open = false;
        return NativeResponse.json(
          body.inConversation === true
            ? { id: "q-1", continueHere: true }
            : { id: "q-1", queued: true },
        );
      }
      if (url.pathname.endsWith("/info"))
        return NativeResponse.json({
          version: "fixture",
          agents: { [BOT]: { description: "Fixture", capabilities: {} } },
          mode: "sse",
          telemetryDisabled: true,
        });
      if (url.pathname.endsWith("/connect"))
        return new NativeResponse(frames([]), {
          headers: { "content-type": "text/event-stream" },
        });
      if (url.pathname.endsWith("/run"))
        return run(RunAgentInputSchema.parse(await request().json()));
      const stop = url.pathname.match(/\/agent\/[^/]+\/stop\/([^/]+)$/);
      if (stop) {
        stopRequests.push(decodeURIComponent(stop[1] ?? ""));
        finishRun?.();
        return NativeResponse.json({ stopped: true });
      }
      if (/\/api\/channels\/[^/]+\/(activity|busy)$/.test(url.pathname))
        return new NativeResponse(null, { status: 204 });
      if (url.pathname === "/api/voice/sessions")
        return NativeResponse.json({ sessions: [], nextCursor: null });
      if (/\/threads\/[^/]+\/messages$/.test(url.pathname))
        return NativeResponse.json({ messages: ASKED });
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
  open = true;
  answers = [];
  runs = [];
  stopRequests = [];
  finishRun = null;
});
afterAll(() => {
  globalThis.fetch = originalFetch;
  GlobalRegistrator.unregister();
});

function conversation() {
  queryClient.setQueryData<ChannelCache>(channelKeys.list(), {
    pages: [
      {
        channels: [
          {
            ...channel,
            summary: null,
            lastMessage: null,
            lastMessageAgentId: null,
            createdAt: "2026-11-06T00:00:00.000Z",
            pinned: false,
            lastReadAt: null,
          },
        ],
        nextCursor: null,
      },
    ],
    pageParams: [""],
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <CopilotKitProvider runtimeUrl="http://localhost/api/copilotkit">
        <ChannelChat channel={channel} runtimeAgentId={BOT} />
      </CopilotKitProvider>
    </QueryClientProvider>,
  );
}

test("the Bot's work on an answer streams in the conversation, and Stop stops it", async () => {
  const view = conversation();
  const user = userEvent.setup({ document: view.container.ownerDocument });
  // The Bot is waiting on the person, and says so above the composer.
  await view.findByRole("region", {
    name: `${channel.name} is waiting on your answer`,
  });
  await view.findByText("Find weekend plans");

  await user.type(
    await view.findByRole("textbox", { name: "Message" }),
    "Chicago",
  );
  await user.click(view.getByRole("button", { name: "Send message" }));

  await waitFor(() => expect(answers).toMatchObject([{ response: "Chicago" }]));
  // The answer is this conversation's next turn, run here, with the question it answers.
  await waitFor(() => expect(runs).toHaveLength(1));
  expect(answers).toEqual([{ response: "Chicago", inConversation: true }]);
  expect(runs[0]?.threadId).toBe(channel.threadId);
  expect(runs[0]?.messages.at(-1)).toEqual({
    id: "person-response:q-1",
    role: "user",
    content: `In response to your question: ${QUESTION}\n\nChicago`,
  });

  // Its work shows while it is happening, not all at once at the end, and it can be stopped.
  await view.findByText(WORKING);
  expect(view.getByText("Chicago")).toBeTruthy();
  expect(view.queryByText(/is reading your answer/)).toBeNull();
  await user.click(await view.findByRole("button", { name: "Stop the Bot" }));
  await waitFor(() => expect(stopRequests).toEqual([channel.threadId]));
  await waitFor(() =>
    expect(view.queryByRole("button", { name: "Stop the Bot" })).toBeNull(),
  );
  // The question is answered: the notice is gone, and nothing else was sent.
  await waitFor(() =>
    expect(
      view.queryByRole("region", {
        name: `${channel.name} is waiting on your answer`,
      }),
    ).toBeNull(),
  );
  expect(runs).toHaveLength(1);
});
