import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import type { Message, RunAgentInput } from "@ag-ui/core";
import { RunAgentInputSchema } from "@ag-ui/core/schemas";
import { CopilotKitProvider, useFrontendTool } from "@copilotkit/react-core/v2";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { OPENBOT_WAITING_METADATA } from "@openbot/shared/waiting";
import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { z } from "zod";
import { ChannelChat } from "@/components/channels/channel-chat";
import { type AgentChannel, channelKeys } from "@/lib/channels/queries";
import { queryClient } from "@/query-client";
import { settleReactWork } from "./settle-react-work";

/**
 * A task's conversation, carried on by the person in the browser.
 *
 * Found there: the Bot asked for Allow once, the person allowed it, the server carried the
 * conversation on, and the first thing they typed next was refused in this browser, "Thread has 1
 * pending interrupt(s) not addressed by resume", with nothing on screen and the words gone on
 * reload. Opening the conversation replays its last run, which ended on the interrupt, and the
 * server's own continuation is a turn no browser streams, so the agent never hears it answered. And
 * a turn that waited on a card in the browser told the roster nothing of what the Bot said after it,
 * so the task's list read the person's own message as the task's outcome.
 *
 * The real provider, ChannelChat and the real AG-UI agent; only the HTTP boundary is synthetic, and
 * the replay is the run as the server records it: a tool call, then RUN_FINISHED on an interrupt.
 */

const NativeResponse = globalThis.Response;
const channel: AgentChannel = {
  id: "waiting-channel",
  name: "Reply to Sam about the spec",
  agentIds: ["waiting-bot"],
  threadId: "waiting-thread",
  active: true,
  lastMessageAt: "2026-10-31T05:51:00.000Z",
};
const ask = {
  id: "ask",
  role: "user",
  content: "Reply to Sam about the spec",
} satisfies Message;
const call = {
  id: "asked-to-send",
  role: "assistant",
  content: "",
  toolCalls: [
    {
      id: "call-send",
      type: "function",
      function: {
        name: "mcp__notion__notion-create-comment",
        arguments: '{"text":"Friday works."}',
      },
    },
  ],
} satisfies Message;

/** What the replayed run ended on, or null for a run that finished. */
let interrupt: Record<string, unknown> | null;
let runRequests: RunAgentInput[] = [];
let runEvents: (input: RunAgentInput) => unknown[];
const ActivitySchema = z.object({
  agentId: z.string().nullable(),
  text: z.string(),
});
let activity: z.infer<typeof ActivitySchema>[] = [];
/** Each time the conversation said a turn started or ended, in order. */
let busy: boolean[] = [];
let originalFetch: typeof fetch;

function sse(events: unknown[]) {
  return new NativeResponse(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
}

beforeAll(() => {
  GlobalRegistrator.register();
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
      if (url.pathname === "/api/agents")
        return NativeResponse.json({ agents: [] });
      if (url.pathname === "/api/plugins/for/waiting-bot")
        return NativeResponse.json({ skills: [], tools: [] });
      if (url.pathname.endsWith("/info"))
        return NativeResponse.json({
          version: "fixture",
          agents: {
            "waiting-bot": { description: "Fixture", capabilities: {} },
          },
          mode: "sse",
          telemetryDisabled: true,
        });
      // The conversation's last run, replayed: it asked to send and stopped for the person.
      if (url.pathname.endsWith("/connect"))
        return sse([
          { type: "RUN_STARTED", threadId: channel.threadId, runId: "task" },
          { type: "MESSAGES_SNAPSHOT", messages: [ask, call] },
          {
            type: "RUN_FINISHED",
            threadId: channel.threadId,
            runId: "task",
            ...(interrupt
              ? { outcome: { type: "interrupt", interrupts: [interrupt] } }
              : {}),
          },
        ]);
      if (url.pathname.endsWith("/run")) {
        const request =
          input instanceof Request ? input : new Request(url, init);
        const body = RunAgentInputSchema.parse(await request.json());
        runRequests.push(body);
        return sse(runEvents(body));
      }
      if (/\/api\/channels\/[^/]+\/activity$/.test(url.pathname)) {
        const request =
          input instanceof Request ? input : new Request(url, init);
        activity.push(ActivitySchema.parse(await request.json()));
        return new NativeResponse(null, { status: 204 });
      }
      if (/\/api\/channels\/[^/]+\/busy$/.test(url.pathname)) {
        const request =
          input instanceof Request ? input : new Request(url, init);
        busy.push(
          z.object({ busy: z.boolean() }).parse(await request.json()).busy,
        );
        return new NativeResponse(null, { status: 204 });
      }
      if (url.pathname === "/api/voice/sessions")
        return NativeResponse.json({ sessions: [], nextCursor: null });
      if (/\/threads\/[^/]+\/messages$/.test(url.pathname))
        return NativeResponse.json({ messages: [ask, call] });
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
});
afterAll(async () => {
  await settleReactWork();
  globalThis.fetch = originalFetch;
  GlobalRegistrator.unregister();
});

/** A tool the browser answers, as the gallery's cards and the computer's tools are. */
function PickDate() {
  useFrontendTool({
    name: "pick_date",
    description: "Ask the person which date works.",
    parameters: z.object({ options: z.array(z.string()) }),
    handler: async () => "Friday",
  });
  return null;
}

function mounting() {
  runRequests = [];
  activity = [];
  busy = [];
  runEvents = (input) => [
    { type: "RUN_STARTED", threadId: input.threadId, runId: input.runId },
    { type: "RUN_FINISHED", threadId: input.threadId, runId: input.runId },
  ];
  queryClient.setQueryData(channelKeys.list(), {
    pages: [
      {
        channels: [
          {
            ...channel,
            summary: null,
            lastMessage: "Waiting for your approval.",
            lastMessageAgentId: "waiting-bot",
            createdAt: "2026-10-31T05:50:00.000Z",
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
        <PickDate />
        <ChannelChat channel={channel} runtimeAgentId="waiting-bot" />
      </CopilotKitProvider>
    </QueryClientProvider>,
  );
}

async function send(view: ReturnType<typeof render>, text: string) {
  const user = userEvent.setup({ document: view.container.ownerDocument });
  const box = await view.findByRole("textbox", { name: "Message" });
  await user.type(box, text);
  await user.click(view.getByRole("button", { name: "Send message" }));
  return box;
}

test("after the person decides a card, their next message is sent though the replayed run ended waiting on it", async () => {
  // The interrupt the server raised for Allow once, carrying what it waits on, as it records it.
  interrupt = {
    id: "call-send",
    reason: "human_input",
    message: "This action is waiting for your approval.",
    metadata: {
      [OPENBOT_WAITING_METADATA]: {
        kind: "approval",
        approvalId: "approval-1",
        requestId: "approval-1",
      },
    },
  };
  const view = mounting();

  await send(view, "Thanks. Now send Ana the spec too.");

  await waitFor(() => expect(runRequests).toHaveLength(1));
  const [sent] = runRequests;
  if (!sent) throw new Error("The message was not sent.");
  expect(sent.threadId).toBe(channel.threadId);
  expect(sent.messages.at(-1)).toMatchObject({
    role: "user",
    content: "Thanks. Now send Ana the spec too.",
  });
  // Sent as a new message, never as an answer to the card the server already carried on.
  expect(sent.resume).toBeUndefined();
});

test("a message that cannot leave the browser says so and goes back in the box", async () => {
  // An interrupt OpenBot did not raise is still the agent's to resume, so this one holds the run.
  interrupt = {
    id: "call-send",
    reason: "human_input",
    message: "Pick an option.",
  };
  const view = mounting();

  const box = await send(view, "Send Ana the spec too.");

  await view.findByText("Your message wasn't sent. Try again.");
  expect(runRequests).toHaveLength(0);
  await waitFor(() => expect(box.textContent).toBe("Send Ana the spec too."));
  expect(view.queryByText("Send Ana the spec too.", { selector: "p" })).toBe(
    null,
  );
});

test("what the Bot says after the browser answers its call is what the conversation last said", async () => {
  interrupt = null;
  const view = mounting();
  // The Bot asks the browser first, and answers once the browser has.
  runEvents = (input) =>
    input.messages.at(-1)?.role === "tool"
      ? [
          { type: "RUN_STARTED", threadId: input.threadId, runId: input.runId },
          {
            type: "TEXT_MESSAGE_START",
            messageId: "outcome",
            role: "assistant",
          },
          {
            type: "TEXT_MESSAGE_CONTENT",
            messageId: "outcome",
            delta: "I couldn't send the reply. Sam hasn't heard back yet.",
          },
          { type: "TEXT_MESSAGE_END", messageId: "outcome" },
          {
            type: "RUN_FINISHED",
            threadId: input.threadId,
            runId: input.runId,
          },
        ]
      : [
          { type: "RUN_STARTED", threadId: input.threadId, runId: input.runId },
          {
            type: "TOOL_CALL_START",
            toolCallId: "pick",
            toolCallName: "pick_date",
            parentMessageId: "picking",
          },
          {
            type: "TOOL_CALL_ARGS",
            toolCallId: "pick",
            delta: '{"options":["Friday","Monday"]}',
          },
          { type: "TOOL_CALL_END", toolCallId: "pick" },
          {
            type: "RUN_FINISHED",
            threadId: input.threadId,
            runId: input.runId,
          },
        ];

  await send(view, "Please send the reply now.");

  await waitFor(() => expect(runRequests).toHaveLength(2));
  await waitFor(() =>
    expect(activity.at(-1)).toEqual({
      agentId: "waiting-bot",
      text: "I couldn't send the reply. Sam hasn't heard back yet.",
    }),
  );
  expect(activity[0]).toEqual({
    agentId: null,
    text: "Please send the reply now.",
  });
  // The whole turn is over: it started once, and ended once.
  await waitFor(() => expect(busy).toEqual([true, false]));
});
