import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { InlineApproval } from "@/components/approvals/inline-approval";
import { WaitingForYou } from "@/components/approvals/waiting";
import { BotNeedsYou } from "@/components/needs-you/board";
import { attachmentAddress } from "@/lib/channels/attachments";
import { approvalInboxResponse } from "./approvals-api";
import { answerBotsList } from "./bots-api";
import { CONVERSATIONS_PATH, TASKS_PATH } from "./conversations-api";
import { CHECK_IN_ITEMS_PATH, pathOf } from "./schedules-api";
import { settleReactWork } from "./settle-react-work";

/*
 * FOUND IN THE END-TO-END PASS (bundle, round 2). In a group conversation, a Bot's reply that sent
 * a file waits for its owner's "Share private information with this group conversation". The
 * request showed the reply as its raw Markdown, "Sent [group-budget.csv](/api/attachments/6888…)."
 * and "Attached: **group-budget.csv**.", so the person deciding whether to share a file read a
 * URL and asterisks and never saw the file. It now reads as the reply will look: the words drawn
 * as the conversation draws them, and each file the held reply carries as its card, which the
 * owner can open, since the file is their Bot's.
 *
 * The request is the one the run held (its words as the Bot wrote them, the file's attachment id),
 * with the file named on it as the server now names it (`args.files`). Drawn on the Bot's page, on
 * the Needs you board and as the card in the conversation.
 */

beforeAll(() => GlobalRegistrator.register({ url: "http://localhost/" }));
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
});

const ATTACHMENT = "6888e790-0e95-409b-8116-90bd3aa0d8b6";
const WORDS = `I’ll create the CSV on my computer and send it here.\n\nSent [group-budget.csv](/api/attachments/${ATTACHMENT}).`;

const share = {
  id: "approval-group-share",
  status: "pending",
  createdAt: "2026-11-17T22:10:00.000Z",
  action: {
    botId: "general-assistant",
    toolRef: "openbot/share_private_information",
    effect: "share_private",
    scope: "group:channel_group:members:6f0c",
    threadId: "thread-group",
    toolCallId: "group-post:m-1:general-assistant",
    args: {
      audience: "this group conversation",
      recipients: 2,
      contentDigest: "5b1e",
      preview: WORDS,
      files: [
        {
          id: ATTACHMENT,
          name: "group-budget.csv",
          mimeType: "text/csv",
          sizeBytes: 96,
        },
      ],
    },
    target: { kind: "group", id: "channel_group" },
  },
};

function serving() {
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    // The owner reads their Bot's file at the conversation's attachment address.
    if (url.includes(`/attachments/${ATTACHMENT}`))
      return new Response(null, { status: 200 });
    {
      const approvals = approvalInboxResponse(url, {
        enabled: true,
        rules: [],
        teamRules: [],
        questions: [],
        requests: [share],
      });
      if (approvals) return approvals;
    }
    if (pathOf(url) === CHECK_IN_ITEMS_PATH)
      return Response.json({ checkInItems: [], nextCursor: null });
    if (url.split("?")[0] === TASKS_PATH)
      return Response.json({ tasks: [], nextCursor: null });
    if (url.split("?")[0] === CONVERSATIONS_PATH)
      return Response.json({ conversations: [], nextCursor: null });
    return (
      answerBotsList(input, init, {
        visible: [{ id: "general-assistant", name: "General Assistant" }],
      }) ?? Response.json({})
    );
  }) as unknown as typeof fetch;
}

function draw(node: ReactNode) {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      {node}
    </QueryClientProvider>,
  );
}

/** Reads as the reply will: no Markdown or address showing, the name a download, the file a card. */
async function readsAsTheReply(scope: HTMLElement) {
  const view = within(scope);
  const said = view.getByLabelText("What it would send");
  expect(said.textContent).toContain(
    "I’ll create the CSV on my computer and send it here.",
  );
  expect(said.textContent).not.toContain("](");
  expect(said.textContent).not.toContain("/api/attachments");
  const link = within(said).getByRole("link", { name: "group-budget.csv" });
  expect(link.getAttribute("href")).toBe(
    attachmentAddress(`/api/attachments/${ATTACHMENT}`),
  );
  expect(link.hasAttribute("download")).toBe(true);
  const card = await view.findByRole("figure", {
    name: "File from the Bot: group-budget.csv",
  });
  expect(card.textContent).toContain("CSV · 96 bytes");
  expect(
    within(card).getByRole("button", { name: "Download group-budget.csv" }),
  ).toBeTruthy();
}

test("on the Bot's page, a held group reply reads as it will look, with its file as a card", async () => {
  serving();
  const view = draw(<WaitingForYou agentId="general-assistant" />);
  await view.findByLabelText("What it would send");
  await readsAsTheReply(view.container);
});

test("on the Needs you board, the same", async () => {
  serving();
  const view = draw(<BotNeedsYou agentId="general-assistant" />);
  await view.findByLabelText("What it would send");
  await readsAsTheReply(view.container);
});

test("as the card in the conversation, the same", async () => {
  serving();
  const view = draw(
    <InlineApproval
      toolCallId="group-post:m-1:general-assistant"
      fallback={null}
    />,
  );
  const card = await view.findByRole("region", {
    name: "Waiting for your approval",
  });
  await readsAsTheReply(card);
});

test("bold in the words is drawn as bold, not as asterisks", async () => {
  serving();
  share.action.args.preview =
    "I’ll create the CSV on my computer and send it here.\n\nAttached: **group-budget.csv**.";
  try {
    const view = draw(<WaitingForYou agentId="general-assistant" />);
    const said = await view.findByLabelText("What it would send");
    expect(said.textContent).not.toContain("**");
    // Bold as the conversation draws it.
    expect(
      within(said)
        .getByText("group-budget.csv")
        .closest('[data-streamdown="strong"]'),
    ).not.toBeNull();
  } finally {
    share.action.args.preview = WORDS;
  }
});
