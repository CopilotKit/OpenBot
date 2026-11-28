import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import type { Message } from "@ag-ui/core";
import { CopilotKitProvider } from "@copilotkit/react-core/v2";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
  within,
} from "@testing-library/react";
import { ChatTranscript } from "@/components/channels/chat-transcript";
import { forgetOpenedLines } from "@/components/channels/tool-line";
import { approvalInboxOptions } from "@/lib/approvals";
import { queryClient } from "@/query-client";
import { approvalInboxResponse, approvalWriteResponse } from "./approvals-api";
import { settleReactWork } from "./settle-react-work";

/**
 * An approval the person answered stays in the conversation, as one line saying what they said.
 *
 * The card folded away once the inbox said it was decided, and gave its place back to the tool's own
 * line ("Create event"). Scrolling back, or opening the conversation again, nothing said the Bot had
 * asked, nor what the person answered: only the Computer's Activity did. Now the card folds into
 * "Allowed once: Create event" (or "Denied: ..."), which opens to the card as it was answered.
 */

const originalFetch = globalThis.fetch;
const CALL = "call-invite";
let inbox: Record<string, unknown>[] = [];

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/" });
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
      const wrote = approvalWriteResponse(url.pathname, init, {
        requests: inbox,
      });
      if (wrote) {
        // The server decides it, and the inbox says so from then on.
        const body = JSON.parse(String(init?.body ?? "{}")) as {
          decision?: string;
        };
        inbox = inbox.map((request) => ({
          ...request,
          status: body.decision === "deny" ? "denied" : "approved",
          decision: body.decision,
          decidedAt: "2026-11-25T10:01:00.000Z",
        }));
        return wrote;
      }
      const approvals = approvalInboxResponse(url.pathname, {
        enabled: true,
        requests: inbox,
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
  forgetOpenedLines();
  inbox = [];
});

afterAll(async () => {
  await settleReactWork();
  globalThis.fetch = originalFetch;
  GlobalRegistrator.unregister();
});

/** A turn that called an app's tool OpenBot asked about, with or without its answer yet. */
function turn(result?: string): Message[] {
  return [
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
    ...(result === undefined
      ? []
      : [
          {
            id: "t1",
            role: "tool" as const,
            toolCallId: CALL,
            content: result,
          },
          {
            id: "a2",
            role: "assistant" as const,
            content: "Done.",
          },
        ]),
  ];
}

function request(status: string, decision: string | null) {
  return {
    id: "approval-1",
    status,
    decision,
    decidedAt: decision ? "2026-11-25T10:01:00.000Z" : null,
    createdAt: "2026-11-25T10:00:00.000Z",
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
}

function draw(messages: Message[]) {
  return render(
    <QueryClientProvider client={queryClient}>
      <CopilotKitProvider>
        <ChatTranscript busy={false} messages={messages} restoring={false} />
      </CopilotKitProvider>
    </QueryClientProvider>,
  );
}

/** The folded line that says what the person answered, found by the words it starts with. */
async function answerLine(view: ReturnType<typeof draw>, said: string) {
  const label = await view.findByText(`${said}:`);
  const line = label.closest("details");
  if (!line) throw new Error(`"${said}:" is not a line that opens`);
  return line;
}

/** What the folded line reads, as a person reads it: the answer, then what it was about. */
function summaryOf(line: HTMLDetailsElement): string {
  return (line.querySelector("summary")?.textContent ?? "")
    .replace("▸", "")
    .replace(/:\s*/, ": ")
    .trim();
}

for (const [status, decision, said] of [
  ["completed", "allow_once", "Allowed once"],
  ["completed", "allow_always", "Always allowed"],
  ["completed", "deny", "Denied"],
] as const)
  test(`opened again, an approval answered ${said} is still in the conversation`, async () => {
    inbox = [request(status, decision)];
    const view = draw(
      turn(
        decision === "deny"
          ? "OpenBot error: The person declined this action."
          : "Event created.",
      ),
    );
    const line = await answerLine(view, said);
    // Folded to one line naming what was asked about, as a Bot's work folds.
    expect(line.open).toBe(false);
    expect(summaryOf(line)).toBe(`${said}: Create event on Google Calendar`);
    expect(
      view.queryByRole("region", { name: "Waiting for your approval" }),
    ).toBeNull();
    // Opened, it is the card as it was answered: why it asked, and the answer.
    fireEvent.click(within(line).getByText(`${said}:`));
    expect(line.open).toBe(true);
    expect(
      within(line).getByText(
        "Sending something to other people asks you first.",
      ),
    ).toBeTruthy();
    expect(within(line).queryByRole("radio")).toBeNull();
  });

test("answered in the conversation, the card folds into the answer's line and stays", async () => {
  inbox = [request("pending", null)];
  const view = draw(turn());
  const card = within(
    await view.findByRole("region", { name: "Waiting for your approval" }),
  );
  fireEvent.click(card.getByRole("radio", { name: "Allow once" }));
  fireEvent.click(card.getByRole("button", { name: "Allow once" }));
  // The inbox's next read says it was decided, and the card gives way to its line.
  await waitFor(() => expect(inbox[0]?.decision).toBe("allow_once"));
  await act(() =>
    queryClient.refetchQueries({ queryKey: approvalInboxOptions().queryKey }),
  );
  const line = await answerLine(view, "Allowed once");
  expect(summaryOf(line)).toBe("Allowed once: Create event on Google Calendar");
  // Still there once the server carried the conversation on and the result came back.
  view.rerender(
    <QueryClientProvider client={queryClient}>
      <CopilotKitProvider>
        <ChatTranscript
          busy={false}
          messages={turn("Event created.")}
          restoring={false}
        />
      </CopilotKitProvider>
    </QueryClientProvider>,
  );
  expect(await answerLine(view, "Allowed once")).toBeTruthy();
});

test("a request a rule decided, with no answer from the person, draws no answer line", async () => {
  inbox = [request("completed", null)];
  const view = draw(turn("Event created."));
  expect(await view.findByText("Done.")).toBeTruthy();
  await act(() =>
    queryClient.refetchQueries({ queryKey: approvalInboxOptions().queryKey }),
  );
  for (const said of ["Allowed once:", "Always allowed:", "Denied:"])
    expect(view.queryByText(said)).toBeNull();
});
