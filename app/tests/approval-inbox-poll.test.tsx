import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
import type { Message } from "@ag-ui/core";
import { CopilotKitContext } from "@copilotkit/react-core/v2/context";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  environmentManager,
  focusManager,
  isServer,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import { cleanup, render, waitFor } from "@testing-library/react";
import { ChatTranscript } from "@/components/channels/chat-transcript";
import { ConversationPresenceProvider } from "@/components/channels/conversation-presence";
import { PAGE_ROWS } from "@/components/channels/transcript-pages";
import { settleReactWork } from "./settle-react-work";

/**
 * A conversation asks for its approvals once a poll, however many tool calls it has.
 *
 * TanStack Query polls once for every component reading a query, and every tool call reads the
 * inbox to know whether it is held on a card. A reply with thirty calls asked thirty times and more
 * every ten seconds. The conversation polls it once, and its rows read what that brings.
 */

const POLL_MS = 10_000;
let asked = 0;
let realFetch: typeof fetch;
let realSetInterval: typeof setInterval;
let realClearInterval: typeof clearInterval;
/** Every ten-second interval started, run by hand below rather than waited for. */
const polls = new Map<number, () => void>();
let nextPoll = 1_000_000;

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/" });
  realFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/approvals")) {
        asked += 1;
        return Response.json({
          enabled: true,
          requests: [],
          rules: [],
          teamRules: [],
          questions: [],
        });
      }
      if (url.includes("/api/channels"))
        return Response.json({ channels: [], nextCursor: null });
      return Response.json({});
    },
    { preconnect: realFetch.preconnect },
  );
});

beforeEach(() => {
  realSetInterval = globalThis.setInterval;
  realClearInterval = globalThis.clearInterval;
  globalThis.setInterval = ((
    callback: () => void,
    delay?: number,
    ...rest: unknown[]
  ) => {
    if (delay !== POLL_MS) return realSetInterval(callback, delay, ...rest);
    nextPoll += 1;
    polls.set(nextPoll, callback);
    return nextPoll;
  }) as typeof setInterval;
  globalThis.clearInterval = ((id?: number) => {
    if (id === undefined || !polls.delete(id)) realClearInterval(id);
  }) as typeof clearInterval;
  // TanStack decides it is on a server when it loads before the DOM does, and a server never polls.
  environmentManager.setIsServer(() => false);
  focusManager.setFocused(true);
});

afterEach(() => {
  cleanup();
  globalThis.setInterval = realSetInterval;
  globalThis.clearInterval = realClearInterval;
  polls.clear();
  environmentManager.setIsServer(() => isServer);
  focusManager.setFocused(undefined);
  asked = 0;
});

afterAll(async () => {
  await settleReactWork();
  globalThis.fetch = realFetch;
  GlobalRegistrator.unregister();
});

/** No renderer is registered for a connector tool, so each call draws the transcript's own line. */
const noRenderers = {
  copilotkit: {
    renderToolCalls: [],
    subscribe: () => ({ unsubscribe() {} }),
  },
  executingToolCallIds: new Set<string>(),
} as never;

/** A reply that said something, searched, and went on, thirty times: thirty rows with a call each. */
const reply: Message[] = [
  { id: "user-1", role: "user", content: "What changed in Q3?" },
  ...Array.from({ length: 30 }, (_, index): Message[] => [
    {
      id: `assistant-${index}`,
      role: "assistant",
      content: `Looking at part ${index + 1}.`,
      toolCalls: [
        {
          id: `call-${index}`,
          type: "function",
          function: {
            name: "mcp__exa__web_search_exa",
            arguments: JSON.stringify({ query: `Q3 part ${index + 1}` }),
          },
        },
      ],
    },
    {
      id: `result-${index}`,
      role: "tool",
      toolCallId: `call-${index}`,
      content: '"Results"',
    },
  ]).flat(),
];

/** One poll's worth of time: each interval fires in turn, as staggered timers do. */
async function onePoll() {
  for (const poll of [...polls.values()]) {
    poll();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

test("a conversation with thirty tool calls asks for its approvals once a poll", async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const view = render(
    <CopilotKitContext.Provider value={noRenderers}>
      <QueryClientProvider client={client}>
        <ConversationPresenceProvider channelId="c-1" threadId="t-1">
          <ChatTranscript messages={reply} />
        </ConversationPresenceProvider>
      </QueryClientProvider>
    </CopilotKitContext.Provider>,
  );
  // It opens at its newest page of rows (`PAGE_ROWS`), each a message or its call: still many calls.
  await waitFor(() =>
    expect(view.getAllByText("Search the web")).toHaveLength(PAGE_ROWS / 2),
  );
  await waitFor(() => expect(asked).toBeGreaterThan(0));
  await settleReactWork();

  asked = 0;
  for (let poll = 0; poll < 3; poll += 1) await onePoll();
  expect(asked).toBe(3);
});
