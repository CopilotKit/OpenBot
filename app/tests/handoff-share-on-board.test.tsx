import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { InlineApproval } from "@/components/approvals/inline-approval";
import { WaitingForYou } from "@/components/approvals/waiting";
import { BotNeedsYou } from "@/components/needs-you/board";
import { approvalInboxResponse } from "./approvals-api";
import { answerBotsList } from "./bots-api";
import { CONVERSATIONS_PATH, TASKS_PATH } from "./conversations-api";
import { CHECK_IN_ITEMS_PATH, pathOf } from "./schedules-api";
import { settleReactWork } from "./settle-react-work";

/*
 * FOUND IN THE ORCHESTRATOR BIG TEST: a hand-off to another person's Bot waits on one card. In the
 * conversation it reads "Hand this to Ledger Bot", says Ledger Bot belongs to someone else so this
 * also shares the text below with them, and shows the text. On the Needs you board the same request
 * read as the server's own fields, "Hand off / Ledger Bot / Preview / … / Audience / Ledger Bot /
 * Recipients / 1", without the sentence, in a box cut off at its foot. The board says what the card
 * says, and both show the whole text, however long.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
});

/** Longer than the 280 characters the server used to cut it at. */
const TEXT = `Find the ledger code for shipment NW-2212 and report the answer directly to the user. Do not invent a code; if you cannot confirm it, say so.

Use a source you can verify; do not guess or invent the code.

The ledger code for shipment NW-2212, with its source, or a clear statement that it could not be confirmed and the reason it could not.`;

/** The one card a hand-off to Noor's Ledger Bot waits on, as the inbox holds it. */
const share = {
  id: "approval-share",
  status: "pending",
  createdAt: "2026-11-16T04:00:00.000Z",
  action: {
    botId: "dana-desk",
    toolRef: "openbot/share_private_information",
    effect: "share_private",
    scope: "handoff:noor",
    threadId: "thread-1",
    toolCallId: "call-handoff",
    covers: "4be1",
    args: {
      audience: "Ledger Bot",
      recipients: 1,
      contentDigest: "9f2c",
      preview: TEXT,
      handOff: "Ledger Bot",
    },
    target: { kind: "handoff", id: "noor" },
  },
};

function serving() {
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
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
        visible: [{ id: "dana-desk", name: "Dana Desk" }],
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

const SENTENCE =
  "Ledger Bot belongs to someone else, so this also shares the text below with them.";

/** Says who reads it and shows the whole text; none of the server's own fields. */
function readsAsTheCard(scope: HTMLElement) {
  const view = within(scope);
  expect(view.getByText(SENTENCE)).toBeTruthy();
  expect(view.getByLabelText("What it would send").textContent).toBe(TEXT);
  for (const field of ["Hand off", "Preview", "Audience", "Recipients"])
    expect(view.queryByText(field)).toBeNull();
  expect(scope.textContent).not.toContain("9f2c");
}

test("on the Needs you board, a hand-off's share reads as its card does: who reads it, and the whole text", async () => {
  serving();
  const view = draw(<BotNeedsYou agentId="dana-desk" />);
  await view.findByLabelText("What it would send");
  readsAsTheCard(view.container);
  // Titled as the card is, who it goes to included.
  expect(view.getByText("Hand this to Ledger Bot")).toBeTruthy();
});

test("on the Bot's page, the same", async () => {
  serving();
  const view = draw(<WaitingForYou agentId="dana-desk" />);
  await view.findByLabelText("What it would send");
  readsAsTheCard(view.container);
  expect(
    view.getByText("Dana Desk wants to hand this to Ledger Bot"),
  ).toBeTruthy();
});

test("in the conversation, the card shows the whole text", async () => {
  serving();
  const view = draw(
    <InlineApproval toolCallId="call-handoff" fallback={null} />,
  );
  const card = await view.findByRole("region", {
    name: "Waiting for your approval",
  });
  readsAsTheCard(card);
});
