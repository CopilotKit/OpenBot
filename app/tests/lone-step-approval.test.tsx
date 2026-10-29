import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import type { Message } from "@ag-ui/core";
import { CopilotKitContext } from "@copilotkit/react-core/v2/context";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  waitFor,
  within,
} from "@testing-library/react";
import { ChatTranscript } from "@/components/channels/chat-transcript";
import { approvalInboxOptions } from "@/lib/approvals";
import { settleReactWork } from "./settle-react-work";

/**
 * A gated call that is the only step of its turn keeps its approval card in the conversation.
 *
 * A run of steps folds into one line with the cards for its waiting calls beside it
 * (`ToolActivity`), but a single server call keeps a line of its own, and that line had no card:
 * the request waited on the Bot's page while the conversation showed a step that never finished.
 * Once decided the card folds to how it went and who decided, and stays.
 */

let approvals: unknown[] = [];
let asked = 0;
let inboxDown = false;
const decisions: { path: string; method?: string; body?: BodyInit | null }[] =
  [];
let realFetch: typeof fetch;

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/" });
  realFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/decision")) {
        decisions.push({
          path: String(input),
          method: init?.method,
          body: init?.body,
        });
        // Decided as the server decides it: the inbox reads the decision back from now on.
        const { decision } = JSON.parse(String(init?.body));
        const status = decision === "deny" ? "denied" : "approved";
        const id = String(input).split("/").at(-2);
        approvals = approvals.map((request) =>
          (request as { id: string }).id === id
            ? { ...(request as object), status, decision }
            : request,
        );
        return Response.json({ id, status });
      }
      if (String(input).endsWith("/api/approvals")) {
        asked += 1;
        if (inboxDown)
          return Response.json({ error: "Inbox unavailable" }, { status: 503 });
        return Response.json({
          enabled: true,
          requests: approvals,
          rules: [],
          teamRules: [],
          questions: [],
        });
      }
      return Response.json({});
    },
    { preconnect: realFetch.preconnect },
  );
});

afterEach(() => {
  cleanup();
  approvals = [];
  asked = 0;
  inboxDown = false;
  decisions.length = 0;
});

afterAll(async () => {
  await settleReactWork();
  globalThis.fetch = realFetch;
  GlobalRegistrator.unregister();
});

const SEND = "mcp__composio-gmail__GMAIL_SEND_EMAIL";

/** The person's answer, then the Bot's one call: the send, still waiting on its result. */
const turn: Message[] = [
  { id: "user-1", role: "user", content: "Double-wall boxes" },
  {
    id: "assistant-1",
    role: "assistant",
    content: "",
    toolCalls: [
      {
        id: "toolu_send",
        type: "function",
        function: {
          name: SEND,
          arguments: JSON.stringify({
            recipient_email: "sam@marlowceramics.com",
            body: "Hi Sam, please use the double-wall boxes.",
          }),
        },
      },
    ],
  },
];

const send = (
  toolCallId: string,
  overrides: Record<string, unknown> = {},
  behaviour: "ask" | "hand_off" = "ask",
) => ({
  id: `approval-${toolCallId}`,
  status: "pending",
  createdAt: "2026-10-22T20:04:43Z",
  action: {
    botId: "inbox",
    toolRef: "gmail/GMAIL_SEND_EMAIL",
    effect: "write",
    scope: "gmail",
    threadId: "thread",
    toolCallId,
    args: {
      recipient_email: "sam@marlowceramics.com",
      subject: "Re: Which box for the Hearth order?",
      body: "Hi Sam, please use the double-wall boxes.",
    },
    target: {},
    policy: {
      behaviour,
      source: "rule",
      reason:
        behaviour === "hand_off"
          ? "Emails to suppliers are yours to send."
          : "Emails ask first.",
    },
  },
  decision: null,
  decidedAt: null,
  completedAt: null,
  result: null,
  ...overrides,
});

/**
 * The transcript asks CopilotKit for a renderer per call. None is registered for a connector tool,
 * which is the case under test: the call is drawn by the transcript's own line.
 */
const noRenderers = {
  copilotkit: {
    renderToolCalls: [],
    subscribe: () => ({ unsubscribe() {} }),
  },
  executingToolCallIds: new Set<string>(),
} as never;

function draw(messages: Message[] = turn) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const view = render(
    <CopilotKitContext.Provider value={noRenderers}>
      <QueryClientProvider client={client}>
        <ChatTranscript messages={messages} />
      </QueryClientProvider>
    </CopilotKitContext.Provider>,
  );
  return { ...view, client };
}

const card = (view: ReturnType<typeof draw>) =>
  view.findByRole("region", { name: "Waiting for your approval" });

test("a gated call alone in its turn draws its approval card under its own line", async () => {
  approvals = [send("toolu_send")];
  const view = draw();
  const waiting = within(await card(view));
  expect(waiting.getByRole("button", { name: "Allow once" })).toBeTruthy();
  expect(waiting.getByRole("button", { name: "Decline" })).toBeTruthy();
  expect(
    waiting.getByRole("button", { name: "Always allow here" }),
  ).toBeTruthy();
  // What will happen, to whom, and what it says, in plain words.
  expect(waiting.getByText("Send your email")).toBeTruthy();
  expect(waiting.getByText("Gmail")).toBeTruthy();
  expect(waiting.getByText("sam@marlowceramics.com")).toBeTruthy();
  expect(waiting.getByText("Re: Which box for the Hearth order?")).toBeTruthy();
  expect(
    waiting.getByText("Hi Sam, please use the double-wall boxes."),
  ).toBeTruthy();
  // Held on its card, the line waits for the person rather than claiming to send.
  expect(view.getByText("Send your email, waiting for you")).toBeTruthy();
  expect(view.queryByText("Sending your email")).toBeNull();
});

test("a request for some other call draws nothing under this one", async () => {
  approvals = [send("toolu_other")];
  const view = draw();
  await waitFor(() => expect(asked).toBeGreaterThan(0));
  await settleReactWork();
  expect(view.getByText("Sending your email")).toBeTruthy();
  expect(view.queryByRole("button", { name: "Allow once" })).toBeNull();
});

test("a decline folds the card to who decided, and it stays folded when the inbox refresh fails", async () => {
  approvals = [send("toolu_send")];
  const view = draw();
  const key = approvalInboxOptions().queryKey;
  const waiting = await card(view);
  inboxDown = true;
  fireEvent.click(within(waiting).getByRole("button", { name: "Decline" }));
  await waitFor(() =>
    expect(view.client.getQueryState(key)?.status).toBe("error"),
  );
  expect(decisions).toEqual([
    {
      path: "/api/approvals/approval-toolu_send/decision",
      method: "POST",
      body: '{"decision":"deny"}',
    },
  ]);
  await waitFor(() =>
    expect(
      view.queryAllByRole("region", { name: "Waiting for your approval" }),
    ).toHaveLength(0),
  );
  expect(view.queryByRole("button", { name: "Allow once" })).toBeNull();
  expect(view.queryByRole("button", { name: "Decline" })).toBeNull();
  expect(view.getByText("Declined")).toBeTruthy();
  expect(view.getByText("Declined by you")).toBeTruthy();
  expect(view.client.getQueryData(key)?.requests[0]).toMatchObject({
    id: "approval-toolu_send",
    status: "denied",
    decision: "deny",
    decidedAt: expect.any(String),
  });
});

test("an allowed send folds to Allowed, then to Sent once it has run", async () => {
  approvals = [send("toolu_send")];
  const view = draw();
  fireEvent.click(
    within(await card(view)).getByRole("button", { name: "Allow once" }),
  );
  expect(await view.findByText("Allowed once by you")).toBeTruthy();
  approvals = [
    send("toolu_send", {
      status: "completed",
      decision: "allow_once",
      decidedAt: "2026-10-22T20:05:00Z",
      completedAt: "2026-10-22T20:05:02Z",
    }),
  ];
  await view.client.invalidateQueries({
    queryKey: approvalInboxOptions().queryKey,
  });
  expect(await view.findByText("Sent")).toBeTruthy();
  expect(view.getByText("Allowed once by you")).toBeTruthy();
  // Folded: the message and the buttons are gone.
  expect(
    view.queryByText("Hi Sam, please use the double-wall boxes."),
  ).toBeNull();
  expect(view.queryByRole("button", { name: "Always allow here" })).toBeNull();
});

test("an action that ran and failed says it didn't work", async () => {
  approvals = [
    send("toolu_send", {
      status: "completed",
      decision: "allow_always",
      decidedAt: "2026-10-22T20:05:00Z",
      result: { error: "Gmail refused the message." },
    }),
  ];
  const view = draw();
  expect(await view.findByText("Didn't work")).toBeTruthy();
  expect(view.getByText("Always allowed here by you")).toBeTruthy();
});

test("a hand-off asks the person to do it, and never offers to let the Bot", async () => {
  approvals = [send("toolu_send", {}, "hand_off")];
  const view = draw();
  const waiting = within(await card(view));
  expect(waiting.getByText("This needs you: Send your email")).toBeTruthy();
  expect(
    waiting.getByText("Handed to you: Emails to suppliers are yours to send."),
  ).toBeTruthy();
  expect(waiting.queryByRole("button", { name: "Allow once" })).toBeNull();
  expect(
    waiting.queryByRole("button", { name: "Always allow here" }),
  ).toBeNull();
  expect(waiting.getByRole("button", { name: "Don't do it" })).toBeTruthy();
  fireEvent.click(waiting.getByRole("button", { name: "I did it myself" }));
  expect(await view.findByText("You did it yourself")).toBeTruthy();
  expect(decisions.map((decision) => decision.body)).toEqual([
    '{"decision":"handled"}',
  ]);
});

test("a send nobody was asked about, because a saved rule allowed it, leaves no card", async () => {
  approvals = [
    send("toolu_send", {
      status: "completed",
      decision: "allow_always",
      action: { ...send("toolu_send").action, policy: undefined },
    }),
  ];
  const view = draw();
  await waitFor(() => expect(asked).toBeGreaterThan(0));
  await settleReactWork();
  expect(view.queryByText("Always allowed here by you")).toBeNull();
});

test("a send the person declined is never named as sent", async () => {
  const declined: Message[] = [
    ...turn,
    {
      id: "result-1",
      role: "tool",
      toolCallId: "toolu_send",
      content:
        "The person declined this action when you asked for their approval, so it was not done.",
    },
  ];
  const view = draw(declined);
  expect(await view.findByText("You declined: Send your email")).toBeTruthy();
  expect(view.queryByText(/Sent your email/)).toBeNull();
});
