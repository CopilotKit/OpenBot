import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import type { Message } from "@ag-ui/core";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, waitFor } from "@testing-library/react";
import { InlineApproval } from "@/components/approvals/inline-approval";
import { type ApprovalInboxData, leftAnswers } from "@/lib/approvals";
import {
  repairUnansweredToolCalls,
  UNANSWERED,
} from "@/lib/copilot/repair-history";
import { settleReactWork } from "./settle-react-work";

/*
 * FOUND IN TESTING. A person allowed a Slack post, the post went out, and the conversation could
 * not be carried on after it. The step sat on "Send message…" with nothing said, so the person
 * never learned the post was made, and the next message sent the Bot "no result came back" for a
 * call that had in fact run, which invites it to post again.
 *
 * The request now says what came of it (`left`). The step draws that sentence, and the next message
 * sends the Bot the answer the conversation never received.
 */

const originalFetch = global.fetch;
beforeAll(() => {
  GlobalRegistrator.register();
});
afterEach(() => {
  cleanup();
  global.fetch = originalFetch;
});
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const DONE =
  "Done: send message on Slack. OpenBot couldn't carry on the conversation after that, so nothing else was done. Send a message to continue.";
const ANSWER =
  'Ran: the app made this change. It answered: {"ok":true,"channel":"C0LAUNCH01"}';

/** `GET /api/approvals`, with one request whose conversation was never carried on. */
function inbox(left: { done: boolean; message: string; answer: string }) {
  return {
    enabled: true,
    requests: [
      {
        id: "approval-1",
        status: "completed",
        createdAt: "2026-11-14T04:06:40Z",
        decidedAt: "2026-11-14T04:06:47Z",
        decision: "allow_once",
        left,
        action: {
          botId: "personal-assistant",
          toolRef: "composio-slack/SLACK_SEND_MESSAGE",
          effect: "write",
          scope: "composio-slack",
          threadId: "thread-1",
          toolCallId: "call-send",
          args: { channel: "C0LAUNCH01", markdown_text: "the deck is ready" },
          target: null,
        },
      },
    ],
    rules: [],
    teamRules: [],
    questions: [],
  } as unknown as ApprovalInboxData;
}

function drawn(data: ApprovalInboxData) {
  global.fetch = (async () => Response.json(data)) as unknown as typeof fetch;
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <InlineApproval fallback={<p>Send message…</p>} toolCallId="call-send" />
    </QueryClientProvider>,
  );
}

test("a step whose conversation could not be carried on says the action was done and what to do next", async () => {
  const view = drawn(inbox({ done: true, message: DONE, answer: ANSWER }));
  const told = await waitFor(() => view.getByTestId("approval-left"));
  expect(told.textContent).toBe(DONE);
  // Said as a status under the step, which is still drawn: nothing replaces the step itself.
  expect(told.getAttribute("role")).toBe("status");
  expect(view.getByText("Send message…")).toBeTruthy();
});

test("one that was not done says so as an alert", async () => {
  const message =
    "Not done: send message on Slack. OpenBot couldn't carry on the conversation. Send a message to try again.";
  const view = drawn(inbox({ done: false, message, answer: "Not done." }));
  const told = await waitFor(() => view.getByTestId("approval-left"));
  expect(told.textContent).toBe(message);
  expect(told.getAttribute("role")).toBe("alert");
});

test("the next message sends the Bot the answer it never received, not that nothing came back", () => {
  const history = [
    { id: "u1", role: "user", content: "Post 'the deck is ready' in #launch." },
    {
      id: "a1",
      role: "assistant",
      content: "",
      toolCalls: [
        {
          id: "call-send",
          type: "function",
          function: { name: "SLACK_SEND_MESSAGE", arguments: "{}" },
        },
        {
          id: "call-other",
          type: "function",
          function: { name: "SLACK_FIND_USERS", arguments: "{}" },
        },
      ],
    },
  ] as unknown as Message[];
  const known = leftAnswers(
    inbox({ done: true, message: DONE, answer: ANSWER }),
  );
  const repaired = repairUnansweredToolCalls(history, () => "minted", known);
  const results = repaired.filter((message) => message.role === "tool") as {
    toolCallId: string;
    content: string;
  }[];
  expect(results.map((result) => [result.toolCallId, result.content])).toEqual([
    ["call-send", ANSWER],
    // A call nothing is known about keeps the words it always had.
    ["call-other", UNANSWERED],
  ]);
  // With nothing known, the same history is repaired as before.
  expect(
    (
      repairUnansweredToolCalls(history, () => "minted").filter(
        (message) => message.role === "tool",
      ) as { content: string }[]
    ).map((result) => result.content),
  ).toEqual([UNANSWERED, UNANSWERED]);
});
