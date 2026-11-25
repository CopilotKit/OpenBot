import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
import type { Message } from "@ag-ui/core";
import {
  CopilotChatConfigurationProvider,
  CopilotChatMessageView,
  CopilotKitProvider,
} from "@copilotkit/react-core/v2";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import type { ReactNode } from "react";
import { ChatTranscript } from "@/components/channels/chat-transcript";
import { TelemetryAssistantMessage } from "@/components/channels/telemetry-assistant-message";
import { queryClient } from "@/query-client";
import { settleReactWork } from "./settle-react-work";

/**
 * COPY UNDER EVERY FINISHED REPLY IN A CONVERSATION.
 *
 * Reported in dogfooding: a conversation's replies had no way to copy them, while the Bot chat page
 * has CopilotKit's own toolbar under each reply. A conversation now draws that same toolbar under a
 * reply once it has finished: Copy puts the reply's words on the clipboard (the text, never the tool
 * cards between them) and records the copy as the Bot chat page does.
 */

const PRODUCT_EVENTS = "/api/v2/organizations/default/product-events";
const originalFetch = globalThis.fetch;
let events: unknown[] = [];
let copied: string[] = [];

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://127.0.0.1:3010/" });
});
beforeEach(() => {
  queryClient.clear();
  events = [];
  copied = [];
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: async (text: string) => {
        copied.push(text);
      },
    },
  });
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === PRODUCT_EVENTS) {
        events.push(JSON.parse(String(init?.body)));
        return new Response(null, { status: 204 });
      }
      return Response.json({
        version: "fixture",
        agents: {},
        mode: "sse",
        telemetryDisabled: true,
      });
    },
    { preconnect: originalFetch.preconnect },
  );
});
afterEach(async () => {
  cleanup();
  await settleReactWork();
  globalThis.fetch = originalFetch;
});
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const THREAD = "thread-copy";

/** A question, then a reply that says something, looks something up, and says what it found. */
const conversation: Message[] = [
  { id: "ask", role: "user", content: "What is on my calendar?" },
  {
    id: "reply-start",
    role: "assistant",
    content: "Let me look at your calendar.",
    toolCalls: [
      {
        id: "call-1",
        type: "function",
        function: { name: "list_events", arguments: "{}" },
      },
    ],
  },
  { id: "result-1", role: "tool", toolCallId: "call-1", content: "[]" },
  {
    id: "reply-end",
    role: "assistant",
    content: "You have **nothing** booked today.",
  },
];

/** The providers a conversation is drawn inside in the app. */
function Conversation({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>
      <CopilotKitProvider
        runtimeUrl="http://127.0.0.1:3010/api/copilotkit"
        enableInspector={false}
      >
        {children}
      </CopilotKitProvider>
    </QueryClientProvider>
  );
}

function transcript(messages: Message[], busy = false) {
  return (
    <Conversation>
      <ChatTranscript busy={busy} messages={messages} threadId={THREAD} />
    </Conversation>
  );
}

async function flush() {
  await act(async () => {});
}

test("a finished reply in a conversation has one Copy, which copies the reply's words and records the copy", async () => {
  const view = render(transcript(conversation));
  const buttons = view.getAllByTestId("copilot-copy-button");
  // One toolbar for the reply, under its last words, not one per paragraph of it.
  expect(buttons).toHaveLength(1);
  const [copy] = buttons;
  if (!copy) throw new Error("No Copy button");
  expect(copy.getAttribute("aria-label")).toBe("Copy");
  // Drawn in the row of the reply's last words.
  const lastWords = view.getByText("nothing").closest("[data-message-id]");
  expect(lastWords?.getAttribute("data-message-id")).toBe("reply-end");
  expect(lastWords?.contains(copy)).toBe(true);

  fireEvent.click(copy);
  await flush();
  expect(copied).toEqual([
    "Let me look at your calendar.\n\nYou have **nothing** booked today.",
  ]);
  expect(events).toEqual([
    {
      kind: "result_copied",
      threadId: THREAD,
      messageId: "reply-end",
      surface: "web",
    },
  ]);
});

test("a reply still being written has no toolbar to reach, only its room; the reply before it keeps its own", () => {
  const next: Message[] = [
    ...conversation,
    { id: "ask-2", role: "user", content: "And tomorrow?" },
    { id: "reply-2", role: "assistant", content: "Tomorrow you have" },
  ];
  const view = render(transcript(next, true));
  const buttons = view.getAllByRole("button", { name: "Copy" });
  expect(buttons).toHaveLength(1);
  expect(
    buttons[0]?.closest("[data-message-id]")?.getAttribute("data-message-id"),
  ).toBe("reply-end");
  // The room is kept, so the reply does not move when it ends, but nothing in it can be reached.
  const writing = view.container.querySelector('[data-message-id="reply-2"]');
  const room = writing?.querySelector("[inert]");
  expect(room?.getAttribute("aria-hidden")).toBe("true");
  expect(room?.classList.contains("invisible")).toBe(true);

  view.rerender(transcript(next));
  expect(view.getAllByRole("button", { name: "Copy" })).toHaveLength(2);
  expect(writing?.querySelector("[inert]")).toBeNull();
});

test("the conversation's toolbar is the Bot chat page's toolbar", () => {
  const ours = render(transcript(conversation)).getByTestId(
    "copilot-assistant-toolbar",
  ).outerHTML;
  cleanup();
  const bot = render(
    <Conversation>
      <CopilotChatConfigurationProvider threadId={THREAD}>
        <CopilotChatMessageView
          messages={[
            { id: "ask", role: "user", content: "Hi" },
            { id: "reply-end", role: "assistant", content: "Hello." },
          ]}
          assistantMessage={TelemetryAssistantMessage}
        />
      </CopilotChatConfigurationProvider>
    </Conversation>,
  );
  expect(ours).toBe(bot.getByTestId("copilot-assistant-toolbar").outerHTML);
});
