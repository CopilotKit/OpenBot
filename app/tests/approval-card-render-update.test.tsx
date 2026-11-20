import { afterAll, afterEach, beforeAll, expect, spyOn, test } from "bun:test";
import type { Message } from "@ag-ui/core";
import { CopilotKitProvider } from "@copilotkit/react-core/v2";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render } from "@testing-library/react";
import { ChatTranscript } from "@/components/channels/chat-transcript";
import { approvalInboxOptions } from "@/lib/approvals";
import { queryClient } from "@/query-client";
import { approvalInboxResponse } from "./approvals-api";
import { settleReactWork } from "./settle-react-work";

/**
 * An approval arriving in an open conversation draws its card without React's "Cannot update a
 * component (`ChatTranscript`) while rendering a different component (`InlineApproval`)" warning.
 *
 * The transcript followed the approval inbox by subscribing to the query cache itself, and the cache
 * tells its subscribers at once, even while a component is rendering: the card's own read of the
 * inbox made a new observer as it rendered, the cache said so, and the transcript was asked to
 * render again from inside the card's render.
 */

const originalFetch = globalThis.fetch;
const CALL = "call-invite";
let inbox: unknown[] = [];

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/" });
  globalThis.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0]) => {
      const url = new URL(
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url,
        "http://localhost",
      );
      const approvals = approvalInboxResponse(url.pathname, {
        enabled: false,
        requests: inbox,
        rules: [],
        teamRules: [],
        questions: [],
      });
      if (approvals) return approvals;
      return Response.json({ error: "not served" }, { status: 404 });
    },
    { preconnect: originalFetch.preconnect },
  );
});

afterEach(() => {
  cleanup();
  queryClient.clear();
  inbox = [];
});

afterAll(async () => {
  await settleReactWork();
  globalThis.fetch = originalFetch;
  GlobalRegistrator.unregister();
});

/** A turn that called an app's tool OpenBot asks about, with no answer yet. */
const invited: Message[] = [
  {
    id: "u1",
    role: "user",
    content: "Invite sam@example.com to Spec review on Friday at 10.",
  },
  {
    id: "a1",
    role: "assistant",
    content: "",
    toolCalls: [
      {
        id: CALL,
        type: "function",
        function: {
          name: "mcp__arcade-GoogleCalendar__CreateEvent",
          arguments: JSON.stringify({
            summary: "Spec review",
            attendee_emails: ["sam@example.com"],
          }),
        },
      },
    ],
  },
];

const waiting = {
  id: "approval-1",
  status: "pending",
  createdAt: "2026-11-05T10:00:00.000Z",
  action: {
    botId: "personal-assistant",
    toolRef: "arcade-GoogleCalendar/CreateEvent",
    effect: "write",
    scope: "arcade-GoogleCalendar",
    threadId: "thread-1",
    toolCallId: CALL,
    args: { summary: "Spec review" },
    target: {},
    policy: {
      behaviour: "ask",
      source: "safety",
      reason: "Sending something to other people asks you first.",
      kind: "sending",
    },
  },
};

const renderUpdates = (calls: unknown[][]) =>
  calls.filter((args) =>
    args.some(
      (arg) =>
        typeof arg === "string" && arg.includes("Cannot update a component"),
    ),
  );

function transcript(messages: Message[]) {
  return (
    <QueryClientProvider client={queryClient}>
      <CopilotKitProvider>
        <ChatTranscript busy={false} messages={messages} restoring={false} />
      </CopilotKitProvider>
    </QueryClientProvider>
  );
}

test("a step and the approval it waits on, arriving together, draw the card without updating the transcript mid-render", async () => {
  // The inbox as it reads once the server has stopped the turn to ask the person.
  inbox = [waiting];
  const asked = await queryClient.fetchQuery(approvalInboxOptions());
  inbox = [];
  queryClient.removeQueries({ queryKey: approvalInboxOptions().queryKey });
  await queryClient.fetchQuery(approvalInboxOptions());

  const errors = spyOn(console, "error");
  try {
    // The conversation is open on the person's message, with nothing waiting on them.
    const view = render(transcript(invited.slice(0, 1)));
    expect(
      await view.findByText(
        "Invite sam@example.com to Spec review on Friday at 10.",
      ),
    ).toBeTruthy();

    // The Bot's step streams in as the inbox read that holds its approval lands: one render.
    inbox = [waiting];
    act(() => {
      queryClient.setQueryData(approvalInboxOptions().queryKey, asked);
      view.rerender(transcript(invited));
    });
    expect(
      await view.findByRole("region", { name: "Waiting for your approval" }),
    ).toBeTruthy();
    await settleReactWork();

    expect(renderUpdates(errors.mock.calls)).toEqual([]);
  } finally {
    errors.mockRestore();
  }
});
