import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import type { Message } from "@ag-ui/core";
import { CopilotKitProvider } from "@copilotkit/react-core/v2";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, within } from "@testing-library/react";
import { ChatTranscript } from "@/components/channels/chat-transcript";
import { HandoffTool } from "@/lib/copilot/handoff-tool";
import { queryClient } from "@/query-client";
import { approvalInboxResponse } from "./approvals-api";
import { settleReactWork } from "./settle-react-work";

/**
 * A Bot handing work to another Bot is decided in the conversation when OpenBot asks about it.
 *
 * Handing work to another person's Bot shares the person's private conversation with someone else,
 * so OpenBot stops the turn and asks them first. A hand-off can also ask because the person asks
 * before changes. Either way the hand-off's own line drew with no card, and the only place to answer
 * was the Bots page. An app's call and a browser step have drawn their card in the conversation all
 * along.
 */

const originalFetch = globalThis.fetch;
const CALL = "call-handoff";
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
      {
        const approvals = approvalInboxResponse(url.pathname, {
          enabled: false,
          requests: inbox,
          rules: [],
          teamRules: [],
          questions: [],
        });
        if (approvals) return approvals;
      }
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

/** A turn in which Handbook asked Pipeline Bot, and has no answer yet. */
const handedOff: Message[] = [
  {
    id: "u1",
    role: "user",
    content: "Ask Pipeline Bot for the pipeline code word.",
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
          name: "message_bot",
          arguments: JSON.stringify({
            bot: "Pipeline Bot",
            task: "What is the pipeline code word?",
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
        <HandoffTool />
        <ChatTranscript busy={false} messages={handedOff} restoring={false} />
      </CopilotKitProvider>
    </QueryClientProvider>,
  );
}

test("a hand-off that shares with another person draws its card in the conversation", async () => {
  inbox = [
    {
      id: "approval-share",
      status: "pending",
      createdAt: "2026-11-15T10:00:00.000Z",
      action: {
        botId: "handbook",
        toolRef: "openbot/share_private_information",
        effect: "share_private",
        scope: "handoff:dana",
        threadId: "thread-1",
        toolCallId: CALL,
        args: {
          audience: "Pipeline Bot",
          recipients: 1,
          contentDigest: "9f2c",
          preview: "What is the pipeline code word?",
        },
        target: { kind: "handoff", id: "dana" },
      },
    },
  ];
  const view = draw();
  const card = within(
    await view.findByRole("region", { name: "Waiting for your approval" }),
  );
  expect(
    card.getByText("Share private information with Pipeline Bot"),
  ).toBeTruthy();
  // What would leave the conversation, before the person says yes.
  expect(card.getByLabelText("What it would send").textContent).toBe(
    "What is the pipeline code word?",
  );
  expect(card.queryByText(/9f2c/)).toBeNull();
  expect(
    card.getByText(
      "Pipeline Bot belongs to someone else, so they can read the text below.",
    ),
  ).toBeTruthy();
  for (const name of ["Allow once", "Deny"])
    expect(card.getByRole("radio", { name })).toBeTruthy();
});

test("a hand-off that both asks first and shares is ONE card that says both", async () => {
  inbox = [
    {
      id: "approval-both",
      status: "pending",
      createdAt: "2026-11-15T10:00:00.000Z",
      action: {
        botId: "handbook",
        toolRef: "openbot/share_private_information",
        effect: "share_private",
        scope: "handoff:dana",
        threadId: "thread-1",
        toolCallId: CALL,
        covers: "4be1",
        args: {
          audience: "Pipeline Bot",
          recipients: 1,
          contentDigest: "9f2c",
          preview: "What is the pipeline code word?",
          handOff: "Pipeline Bot",
        },
        target: { kind: "handoff", id: "dana" },
      },
    },
  ];
  const view = draw();
  const cards = await view.findAllByRole("region", {
    name: "Waiting for your approval",
  });
  expect(cards).toHaveLength(1);
  const [only] = cards;
  if (!only) throw new Error("No card.");
  const card = within(only);
  // It is handed over, and it shares this text with someone else: both, on the one card.
  expect(card.getByText("Hand this to Pipeline Bot")).toBeTruthy();
  expect(
    card.getByText(
      "Pipeline Bot belongs to someone else, so this also shares the text below with them.",
    ),
  ).toBeTruthy();
  expect(card.getByLabelText("What it would send").textContent).toBe(
    "What is the pipeline code word?",
  );
  expect(card.getByRole("radio", { name: "Allow once" })).toBeTruthy();
  expect(card.getByRole("radio", { name: "Deny" })).toBeTruthy();
});

test("a hand-off the person asks before draws its card in the conversation", async () => {
  inbox = [
    {
      id: "approval-delegate",
      status: "pending",
      createdAt: "2026-11-15T10:00:00.000Z",
      action: {
        botId: "handbook",
        toolRef: "bot/message_bot",
        effect: "delegate",
        scope: "Pipeline Bot",
        threadId: "thread-1",
        toolCallId: CALL,
        args: { bot: "Pipeline Bot", task: "What is the pipeline code word?" },
        target: { bot: "Pipeline Bot" },
        policy: {
          behaviour: "ask",
          source: "default",
          reason: "You asked to be asked before changes.",
        },
      },
    },
  ];
  const view = draw();
  const card = within(
    await view.findByRole("region", { name: "Waiting for your approval" }),
  );
  expect(card.getByText("Ask Pipeline Bot")).toBeTruthy();
  expect(card.getByRole("radio", { name: "Allow once" })).toBeTruthy();
  expect(card.getByRole("radio", { name: "Deny" })).toBeTruthy();
});

test("with nothing waiting, the hand-off is the line it always was", async () => {
  const view = draw();
  expect(await view.findByText("Asked Pipeline Bot")).toBeTruthy();
  expect(
    view.queryByRole("region", { name: "Waiting for your approval" }),
  ).toBeNull();
});
