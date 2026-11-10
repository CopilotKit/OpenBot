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
  type ChannelSummary,
  channelKeys,
} from "@/lib/channels/queries";
import { UNANSWERED } from "@/lib/copilot/repair-history";
import { queryClient } from "@/query-client";
import {
  ANSWERED_EARLY,
  answerOf,
  LOOKUPS,
  lookupsStored,
} from "./parallel-lookups.fixture";

/*
 * A message sent from a conversation that missed the end of a step of parallel lookups carries the
 * answers the server stored, not a sentence saying they were interrupted.
 *
 * Found live: a Bot sent 20 lookups at once, the person came back to the conversation while 9 were
 * still running, and the conversation on screen held 11 answers. The server finished the other 9 and
 * stored them; the screen never heard. The person's next message went out with "This call produced
 * no result: the surface was interrupted before it could answer" for each of the 9, and the Bot told
 * them 9 of its lookups had failed, for no reason it could find.
 *
 * The real chat, its history reader and the CopilotKit core, against a runtime that answers as the
 * real one does over SSE. Only the HTTP boundary is a stand-in.
 */

type ChannelCache = InfiniteData<ChannelPage>;
const NativeResponse = globalThis.Response;
const BOT = "planner-bot";
const channel: AgentChannel = {
  id: "planner-channel",
  name: "Cycle planning",
  agentIds: [BOT],
  threadId: "planner-thread",
  active: true,
  lastMessageAt: "2026-11-09T00:00:00.000Z",
};
/** What a call nothing answered is sent as. */
const INTERRUPTED = UNANSWERED;

/** How many of the 20 answers the thread's store holds now. */
let storedAnswers = ANSWERED_EARLY;
let runs: RunAgentInput[] = [];
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
      if (url.pathname.endsWith("/info"))
        return NativeResponse.json({
          version: "fixture",
          agents: { [BOT]: { description: "Fixture", capabilities: {} } },
          mode: "sse",
          telemetryDisabled: true,
        });
      // Joining replays the step as far as it had got when the conversation was opened.
      if (url.pathname.endsWith("/connect"))
        return sse([
          { type: "RUN_STARTED", threadId: channel.threadId, runId: "join" },
          {
            type: "MESSAGES_SNAPSHOT",
            messages: lookupsStored("asked", ANSWERED_EARLY),
          },
          { type: "RUN_FINISHED", threadId: channel.threadId, runId: "join" },
        ]);
      if (url.pathname.endsWith("/run")) {
        const request =
          input instanceof Request ? input : new Request(url, init);
        const body = RunAgentInputSchema.parse(await request.json());
        runs.push(body);
        return sse([
          { type: "RUN_STARTED", threadId: body.threadId, runId: body.runId },
          { type: "RUN_FINISHED", threadId: body.threadId, runId: body.runId },
        ]);
      }
      if (/\/api\/channels\/[^/]+\/(activity|busy)$/.test(url.pathname))
        return new NativeResponse(null, { status: 204 });
      if (url.pathname === "/api/voice/sessions")
        return NativeResponse.json({ sessions: [], nextCursor: null });
      if (/\/threads\/[^/]+\/messages$/.test(url.pathname))
        return NativeResponse.json({
          messages: lookupsStored("asked", storedAnswers),
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
  runs = [];
  storedAnswers = ANSWERED_EARLY;
});
afterAll(() => {
  globalThis.fetch = originalFetch;
  GlobalRegistrator.unregister();
});

function opened() {
  const summary: ChannelSummary = {
    ...channel,
    summary: null,
    lastMessage: null,
    lastMessageAgentId: BOT,
    lastMessageAt: channel.lastMessageAt,
    createdAt: "2026-11-09T00:00:00.000Z",
    pinned: false,
    lastReadAt: null,
  };
  queryClient.setQueryData<ChannelCache>(channelKeys.list(), {
    pages: [{ channels: [summary], nextCursor: null }],
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

/** Each call's answer in what was sent, by call. */
function answersSent(messages: Message[]): Map<string, string> {
  return new Map(
    messages.flatMap((message) =>
      message.role === "tool"
        ? [[message.toolCallId, String(message.content)] as const]
        : [],
    ),
  );
}

test("the next message carries every lookup's stored answer, never an interrupted one", async () => {
  const view = opened();
  const user = userEvent.setup({ document: view.container.ownerDocument });
  const box = await view.findByRole("textbox", { name: "Message" });
  // While the person reads, the server finishes the 9 lookups and stores their answers.
  storedAnswers = LOOKUPS.length;
  await user.type(box, "How do I know you're still working on it?");
  await user.click(view.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(runs).toHaveLength(1));

  const sent = runs[0]?.messages ?? [];
  expect(
    sent.filter(
      (message) =>
        message.role === "tool" &&
        String(message.content).includes(INTERRUPTED),
    ),
  ).toEqual([]);
  const answers = answersSent(sent);
  expect(LOOKUPS.map((lookup) => answers.get(lookup.id))).toEqual(
    LOOKUPS.map((_, index) => answerOf(index)),
  );
  // Each answer follows the message that asked for it, and the person's words come after them all.
  const calling = sent.findIndex(
    (message) => message.role === "assistant" && message.toolCalls?.length,
  );
  expect(
    sent.slice(calling + 1, calling + 1 + LOOKUPS.length).map((m) => m.role),
  ).toEqual(LOOKUPS.map(() => "tool"));
  expect(sent.at(-1)).toMatchObject({
    role: "user",
    content: "How do I know you're still working on it?",
  });
});

test("a lookup nobody answered is still said to have no result", async () => {
  // The store has no more than the screen: the 9 never answered anywhere.
  const view = opened();
  const user = userEvent.setup({ document: view.container.ownerDocument });
  const box = await view.findByRole("textbox", { name: "Message" });
  await user.type(box, "Carry on");
  await user.click(view.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(runs).toHaveLength(1));

  const answers = answersSent(runs[0]?.messages ?? []);
  for (const [index, lookup] of LOOKUPS.entries()) {
    if (index < ANSWERED_EARLY)
      expect(answers.get(lookup.id)).toBe(answerOf(index));
    else expect(answers.get(lookup.id)).toContain(INTERRUPTED);
  }
});
