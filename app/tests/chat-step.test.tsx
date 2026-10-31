import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import type { Message } from "@ag-ui/core";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render } from "@testing-library/react";
import { useState } from "react";
import {
  ConversationPresenceProvider,
  useConversationOrb,
  useConversationStatus,
  useReportConversation,
} from "@/components/channels/conversation-presence";
import { readToolName } from "@/lib/plugins/tool-name";
import { type StepApproval, stepFor, THINKING } from "@/lib/channels/step";
import { settleReactWork } from "./settle-react-work";

/**
 * The line under a conversation's name says what its Bot is doing right now: the step it is
 * running, in the words that step's own line uses, or that it is thinking, and nothing once the
 * turn is over.
 */

beforeAll(() => GlobalRegistrator.register({ url: "http://localhost/" }));
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const asked = (id: string, content: string): Message => ({
  id,
  role: "user",
  content,
});

/** The Bot calling a tool, answered when `result` is given. */
function called(id: string, name: string, result?: string): Message[] {
  const call: Message = {
    id: `${id}-call`,
    role: "assistant",
    content: "",
    toolCalls: [
      {
        id,
        type: "function",
        function: { name, arguments: JSON.stringify({ query: "Q3 budget" }) },
      },
    ],
  };
  return result === undefined
    ? [call]
    : [
        call,
        { id: `${id}-result`, role: "tool", toolCallId: id, content: result },
      ];
}

const SEARCH = "mcp__exa__web_search_exa";
const FETCH = "mcp__exa__web_fetch_exa";

test("a declined email stops being named before the tool result arrives", () => {
  const declined: StepApproval = {
    status: "denied",
    decision: "deny",
    action: { toolCallId: "send" },
  };
  const messages = [
    asked("u1", "Reply to Ana"),
    ...called("send", "mcp__google-workspace__gmail_send_reply"),
  ];
  expect(stepFor(messages, true)).toBe("Sending your email");
  expect(stepFor(messages, true, [declined])).toBe(THINKING);
  // Done by the person themselves, it does not run here either.
  expect(
    stepFor(messages, true, [
      {
        status: "approved",
        decision: "handled",
        action: { toolCallId: "send" },
      },
    ]),
  ).toBe(THINKING);
  // Allowed, it is the step the Bot is on.
  expect(
    stepFor(messages, true, [
      {
        status: "approved",
        decision: "allow_once",
        action: { toolCallId: "send" },
      },
    ]),
  ).toBe("Sending your email");
});

describe("the step the line names", () => {
  test("a step still running is named as its line names it", () => {
    const messages = [asked("u1", "What changed?"), ...called("s", SEARCH)];
    expect(stepFor(messages, true)).toBe("Searching the web");
    expect(stepFor(messages, true)).toBe(readToolName(SEARCH, true).label);
  });

  test("the newest running step wins over an earlier one", () => {
    const messages = [
      asked("u1", "What changed?"),
      ...called("s", SEARCH),
      ...called("f", FETCH),
    ];
    expect(stepFor(messages, true)).toBe("Reading web pages");
    expect(stepFor(messages, true)).toBe(readToolName(FETCH, true).label);
  });

  test("a step that has its result is not running", () => {
    const messages = [
      asked("u1", "What changed?"),
      ...called("s", SEARCH),
      ...called("f", FETCH, '"Page text"'),
    ];
    expect(stepFor(messages, true)).toBe("Searching the web");
  });

  test("working with no step running is thinking", () => {
    expect(stepFor([asked("u1", "Hi")], true)).toBe(THINKING);
    const answered = [
      asked("u1", "What changed?"),
      ...called("s", SEARCH, '"Results"'),
    ];
    expect(stepFor(answered, true)).toBe(THINKING);
  });

  test("a call an earlier turn left unanswered is not this turn's step", () => {
    const messages = [
      asked("u1", "What changed?"),
      ...called("s", SEARCH),
      asked("u2", "Never mind, what's on today?"),
    ];
    expect(stepFor(messages, true)).toBe(THINKING);
  });

  test("the person's mail and calendar are named for what happens to them, through any app", () => {
    const ask = asked("u1", "Anything from Priya?");
    const workspace = (tool: string) => [
      ask,
      ...called("g", `mcp__google-workspace__${tool}`),
    ];
    expect(stepFor(workspace("gmail_search_messages"), true)).toBe(
      "Searching your email",
    );
    expect(stepFor(workspace("gmail_read_message"), true)).toBe(
      "Reading your email",
    );
    expect(stepFor(workspace("calendar_list_events"), true)).toBe(
      "Checking your calendar",
    );
    expect(stepFor(workspace("gmail_send_reply"), true)).toBe(
      "Sending your email",
    );
    // A brokered Gmail is the same mailbox, in the same words its line uses.
    expect(
      stepFor(
        [ask, ...called("c", "mcp__composio-gmail__GMAIL_FETCH_EMAILS")],
        true,
      ),
    ).toBe("Reading your email");
  });

  test("the browser, memory and the deployment's own tools say what they do", () => {
    const ask = asked("u1", "Book it");
    expect(stepFor([ask, ...called("b", "computer_navigate")], true)).toBe(
      "Working in your browser",
    );
    expect(stepFor([ask, ...called("m", "recall_personal_memory")], true)).toBe(
      "Checking memory",
    );
    expect(stepFor([ask, ...called("a", "show_app_access")], true)).toBe(
      "Checking app access",
    );
  });

  test("an app's call it cannot name by what it does is named by the app, never its identifier", () => {
    const messages = [
      asked("u1", "Do the thing"),
      ...called("x", "mcp__acme__frobnicate_widgets"),
    ];
    expect(stepFor(messages, true)).toBe("Using Acme");
    // A mail call that changes something keeps its own name on its line, so here it is the app.
    expect(
      stepFor(
        [
          asked("u1", "Draft it"),
          ...called("d", "mcp__google-workspace__gmail_create_draft"),
        ],
        true,
      ),
    ).toBe("Using Google Workspace");
  });

  test("a question for the person and a drawn interface are not named; the step before them is", () => {
    const messages = [
      asked("u1", "What changed?"),
      ...called("s", SEARCH),
      ...called("q", "ask_person"),
      ...called("f", "askForm"),
    ];
    expect(stepFor(messages, true)).toBe("Searching the web");
    expect(
      stepFor([asked("u1", "Hi"), ...called("c", "showBarChart")], true),
    ).toBe(THINKING);
  });

  test("no phrase carries an ellipsis or a tool's identifier", () => {
    for (const name of [
      "mcp__google-workspace__gmail_search_messages",
      "mcp__google-workspace__calendar_list_events",
      "mcp__google-workspace__gmail_create_draft",
      "mcp__acme__frobnicate_widgets",
      "make_page",
      "show_app_access",
    ]) {
      const step =
        stepFor([asked("u1", "Go"), ...called("x", name)], true) ?? "";
      expect(step).not.toContain("…");
      expect(step).not.toMatch(
        /_|google-workspace|Gmail search|Calendar list|Frobnicate/,
      );
    }
    expect(THINKING).toBe("Thinking it through");
  });

  test("with the turn over there is nothing to say, running step or not", () => {
    const messages = [asked("u1", "What changed?"), ...called("s", SEARCH)];
    expect(stepFor(messages, false)).toBeNull();
    expect(stepFor([], false)).toBeNull();
  });
});

test("a keystroke does not reach the status line, and a new step does not reach the orb", () => {
  let report: ReturnType<typeof useReportConversation>;
  let nextMessages: (messages: Message[]) => void = () => {};
  const renders = { status: 0, orb: 0 };

  function Reporter() {
    const [messages, setMessages] = useState<Message[]>([
      asked("u1", "What changed?"),
    ]);
    nextMessages = setMessages;
    report = useReportConversation({ working: true, failed: false, messages });
    return null;
  }
  function StatusProbe() {
    renders.status++;
    const status = useConversationStatus();
    return (
      <output data-probe="status">
        {status.kind === "working" ? status.step : status.kind}
      </output>
    );
  }
  function OrbProbe() {
    renders.orb++;
    return <output data-probe="orb">{useConversationOrb()}</output>;
  }

  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  client.setQueryData(["approvals"], {
    enabled: true,
    requests: [],
    rules: [],
    teamRules: [],
    questions: [],
  });
  client.setQueryData(["channels", "list"], {
    pages: [{ channels: [], nextCursor: null }],
    pageParams: [""],
  });
  const view = render(
    <QueryClientProvider client={client}>
      <ConversationPresenceProvider channelId="c-1" threadId="t-1">
        <Reporter />
        <StatusProbe />
        <OrbProbe />
      </ConversationPresenceProvider>
    </QueryClientProvider>,
  );
  const probe = (name: string) =>
    view.container.querySelector(`[data-probe='${name}']`)?.textContent;
  expect(probe("status")).toBe(THINKING);
  expect(probe("orb")).toBe("thinking");

  const atStart = { ...renders };
  act(() => report?.onTextChange("A correction"));
  act(() => report?.onTextChange("A correction, typed on"));
  expect(renders.status).toBe(atStart.status);

  const afterTyping = { ...renders };
  act(() =>
    nextMessages([asked("u1", "What changed?"), ...called("s", SEARCH)]),
  );
  expect(probe("status")).toBe("Searching the web");
  expect(renders.status).toBeGreaterThan(afterTyping.status);
  expect(renders.orb).toBe(afterTyping.orb);
});
