import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import type { Message } from "@ag-ui/core";
import { CopilotKitProvider } from "@copilotkit/react-core/v2";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, within } from "@testing-library/react";
import { ChatTranscript } from "@/components/channels/chat-transcript";
import { queryClient } from "@/query-client";
import { settleReactWork } from "./settle-react-work";

/**
 * An app's tool that OpenBot asks about is decided in the conversation, where the person is.
 *
 * An app's tool runs on the server, and the server stops the turn and opens a request for the
 * person (`HeadlessToolSuspension`, server/src/approvals/service.ts). The conversation drew that
 * call as a line still running, with no card, so the only place to answer was the Bots page. A
 * browser step's card was drawn in the conversation all along.
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
      if (url.pathname === "/api/approvals")
        return Response.json({
          enabled: false,
          requests: inbox,
          rules: [],
          teamRules: [],
          questions: [],
        });
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

/** A turn that called Arcade's Google Calendar to invite somebody, and has no answer yet. */
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

function draw() {
  return render(
    <QueryClientProvider client={queryClient}>
      <CopilotKitProvider>
        <ChatTranscript busy={false} messages={invited} restoring={false} />
      </CopilotKitProvider>
    </QueryClientProvider>,
  );
}

test("an app's call OpenBot asks about draws its card in the conversation", async () => {
  inbox = [
    {
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
          reason: "Sending something to other people always asks you first.",
        },
      },
    },
  ];
  const view = draw();
  const card = within(
    await view.findByRole("region", { name: "Waiting for your approval" }),
  );
  expect(
    card.getByText("Sending something to other people always asks you first."),
  ).toBeTruthy();
  expect(card.getByRole("button", { name: "Allow once" })).toBeTruthy();
  expect(card.getByRole("button", { name: "Deny" })).toBeTruthy();
  expect(card.queryByRole("button", { name: "Always allow here" })).toBeNull();
});

test("with nothing waiting, the call is the line it always was", async () => {
  const view = draw();
  expect(await view.findByText("Create event")).toBeTruthy();
  expect(
    view.queryByRole("region", { name: "Waiting for your approval" }),
  ).toBeNull();
});
