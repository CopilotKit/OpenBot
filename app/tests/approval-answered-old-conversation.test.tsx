import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import type { Message } from "@ag-ui/core";
import {
  CopilotChatConfigurationProvider,
  CopilotKitProvider,
} from "@copilotkit/react-core/v2";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { ChatTranscript } from "@/components/channels/chat-transcript";
import { forgetOpenedLines } from "@/components/channels/tool-line";
import { approvalInboxOptions } from "@/lib/approvals";
import { queryClient } from "@/query-client";
import {
  approvalInboxResponse,
  conversationApprovalsPath,
  conversationApprovalsResponse,
} from "./approvals-api";
import { settleReactWork } from "./settle-react-work";

/**
 * An answered approval stays in its conversation as one line ("Allowed once: Create event on
 * Google Calendar"), however old the conversation is.
 *
 * The line was drawn from the inbox, and the inbox holds only the person's last hundred approvals,
 * across every conversation. Opening an older conversation, whose approvals had all fallen out of
 * those hundred, drew no line at all: nothing said the Bot had asked or what the person answered.
 * The conversation now reads its own approvals too, by its thread, and the server answers each
 * person with only the approvals they were asked.
 */

const originalFetch = globalThis.fetch;
const OLD_THREAD = "thread-from-august";
const CALL = "call-invite";
/** Who the server is answering: the person who was asked, or somebody else in the organization. */
let signedIn: "asked" | "someone-else" = "asked";
const asked: string[] = [];

/** The answer the person gave in August, in the old conversation. */
const answered = {
  id: "approval-august",
  status: "completed",
  decision: "allow_once",
  createdAt: "2026-08-03T09:12:44.501Z",
  decidedAt: "2026-08-03T09:13:02.118Z",
  action: {
    botId: "personal-assistant",
    toolRef: "arcade-GoogleCalendar/CreateEvent",
    effect: "write",
    scope: "arcade-GoogleCalendar",
    threadId: OLD_THREAD,
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

/** The person's last hundred approvals, all asked since, in other conversations. */
const lastHundred = Array.from({ length: 100 }, (_, index) => ({
  id: `approval-recent-${index}`,
  status: "completed",
  decision: "allow_once",
  createdAt: "2026-11-20T09:00:00.000Z",
  decidedAt: "2026-11-20T09:00:30.000Z",
  action: {
    botId: "personal-assistant",
    toolRef: "arcade-Gmail/SendEmail",
    effect: "write",
    scope: "arcade-Gmail",
    threadId: `thread-recent-${index}`,
    toolCallId: `call-recent-${index}`,
    args: {},
    target: {},
  },
}));

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
      asked.push(url.pathname);
      // The conversation's own approvals: the asker's own only, as the server keeps them.
      if (url.pathname === conversationApprovalsPath(OLD_THREAD))
        return conversationApprovalsResponse(
          signedIn === "asked" ? [answered] : [],
        );
      const inbox = approvalInboxResponse(url.pathname, {
        enabled: true,
        requests: signedIn === "asked" ? lastHundred : [],
      });
      if (inbox) return inbox;
      return Response.json({ error: "not served" }, { status: 404 });
    },
    { preconnect: originalFetch.preconnect },
  );
});

afterEach(() => {
  cleanup();
  queryClient.clear();
  forgetOpenedLines();
  signedIn = "asked";
  asked.length = 0;
});

afterAll(async () => {
  await settleReactWork();
  globalThis.fetch = originalFetch;
  GlobalRegistrator.unregister();
});

/** The old conversation: the Bot created the event once the person allowed it. */
const turn: Message[] = [
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
          arguments: JSON.stringify({ summary: "Spec review" }),
        },
      },
    ],
  },
  { id: "t1", role: "tool", toolCallId: CALL, content: "Event created." },
  { id: "a2", role: "assistant", content: "Done." },
];

/** The old conversation opened again, drawn as its screen draws it. */
function open() {
  return render(
    <QueryClientProvider client={queryClient}>
      <CopilotKitProvider>
        <CopilotChatConfigurationProvider
          agentId="default"
          threadId={OLD_THREAD}
        >
          <ChatTranscript busy={false} messages={turn} restoring={false} />
        </CopilotChatConfigurationProvider>
      </CopilotKitProvider>
    </QueryClientProvider>,
  );
}

test("an old conversation whose approvals fell out of the last hundred still shows what the person answered", async () => {
  const view = open();
  const label = await view.findByText("Allowed once:");
  const line = label.closest("details");
  expect(line?.querySelector("summary")?.textContent).toContain(
    "Create event on Google Calendar",
  );
  // Read for this conversation, by its thread.
  expect(asked).toContain(conversationApprovalsPath(OLD_THREAD));
});

test("somebody who wasn't asked sees no answer in the conversation", async () => {
  signedIn = "someone-else";
  const view = open();
  expect(await view.findByText("Done.")).toBeTruthy();
  await waitFor(() =>
    expect(asked).toContain(conversationApprovalsPath(OLD_THREAD)),
  );
  await act(() =>
    queryClient.refetchQueries({ queryKey: approvalInboxOptions().queryKey }),
  );
  for (const said of ["Allowed once:", "Always allowed:", "Denied:"])
    expect(view.queryByText(said)).toBeNull();
});
