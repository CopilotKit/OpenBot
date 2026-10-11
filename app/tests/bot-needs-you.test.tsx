import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { BotNeedsYou } from "@/components/approvals/waiting";
import { SuggestionsInbox } from "@/components/suggestions/proactive-panel";
import { settleReactWork } from "./settle-react-work";

/**
 * The top of a Bot's page: what that Bot is waiting on the person for, decided right there, and the
 * next steps its background research suggested.
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

const request = (
  id: string,
  botId: string,
  behaviour: "ask" | "hand_off" = "ask",
) => ({
  id,
  status: "pending",
  createdAt: "2026-10-09T10:00:00Z",
  action: {
    botId,
    toolRef: "computer_click",
    effect: "write",
    scope: "shop.example",
    threadId: "thread",
    args: { element: "Pay now" },
    target: {},
    policy: {
      behaviour,
      source: "rule",
      reason: behaviour === "hand_off" ? "Paying is done by you." : "Asked.",
    },
  },
});

let inbox: Record<string, unknown> = {};
const sent: { path: string; method: string; body: unknown }[] = [];
function serving() {
  sent.length = 0;
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (init?.method && init.method !== "GET") {
      sent.push({
        path: url,
        method: init.method,
        body: init.body ? JSON.parse(String(init.body)) : undefined,
      });
      return Response.json({ ok: true });
    }
    if (url === "/api/approvals") return Response.json(inbox);
    if (url === "/api/proactive/suggestions") {
      return Response.json({
        suggestions: [
          {
            id: "s1",
            agentId: "expenses",
            title: "Chase the March invoice",
            detail: "",
            sourceApp: null,
            sourceLink: null,
            createdAt: "2026-10-09T10:00:00Z",
          },
          {
            id: "s2",
            agentId: "knowledge",
            title: "Archive old pages",
            detail: "",
            sourceApp: null,
            sourceLink: null,
            createdAt: "2026-10-09T10:00:00Z",
          },
        ],
      });
    }
    return Response.json({
      agents: [
        { id: "expenses", name: "Expenses" },
        { id: "knowledge", name: "Knowledge" },
      ],
    });
  }) as unknown as typeof fetch;
}

function draw(node: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>{node}</QueryClientProvider>,
  );
}

const base = {
  enabled: true,
  rules: [],
  teamRules: [],
};

test("the target of a waiting action is shown whole, however long", async () => {
  const long = request("r1", "expenses");
  long.action.scope =
    "https://checkout.example/carts/0f8e2a4c-9b1d-4f6e-a3c7-5d2e8b1f9a04/pay";
  inbox = { ...base, requests: [long], questions: [] };
  serving();
  const view = draw(<BotNeedsYou agentId="expenses" />);
  const scope = await view.findByText(long.action.scope);
  expect(scope.className).toContain("line-clamp-none");
  expect(scope.className).toContain("break-all");
});

test("only what this Bot waits on is shown, and it can be decided here", async () => {
  inbox = {
    ...base,
    requests: [request("r1", "expenses"), request("r2", "knowledge")],
    questions: [
      {
        id: "q1",
        botId: "expenses",
        threadId: "thread",
        question: "Which card?",
        createdAt: "2026-10-09T10:00:00Z",
      },
      {
        id: "q2",
        botId: "knowledge",
        threadId: "thread",
        question: "Which wiki?",
        createdAt: "2026-10-09T10:00:00Z",
      },
    ],
  };
  serving();
  const view = draw(<BotNeedsYou agentId="expenses" />);
  expect(await view.findByText("Needs you")).toBeTruthy();
  expect(view.getByText(/Which card\?/)).toBeTruthy();
  expect(view.queryByText(/Which wiki\?/)).toBeNull();
  expect(view.getAllByRole("button", { name: "Allow once" })).toHaveLength(1);
  expect(view.getByRole("button", { name: "Always allow here" })).toBeTruthy();
  expect(view.getByRole("button", { name: "Deny" })).toBeTruthy();
  expect(view.getByRole("button", { name: "Send answer" })).toBeTruthy();
  fireEvent.click(view.getByRole("button", { name: "Allow once" }));
  await waitFor(() =>
    expect(sent).toContainEqual({
      path: "/api/approvals/r1/decision",
      method: "POST",
      body: { decision: "allow_once" },
    }),
  );
});

test("a hand-off is marked done by the person, never allowed on their behalf", async () => {
  inbox = {
    ...base,
    requests: [request("r1", "expenses", "hand_off")],
    questions: [],
  };
  serving();
  const view = draw(<BotNeedsYou agentId="expenses" />);
  await view.findByText(/Handed to you: Paying/);
  expect(view.queryByRole("button", { name: "Allow once" })).toBeNull();
  fireEvent.click(view.getByRole("button", { name: "I did it myself" }));
  await waitFor(() =>
    expect(sent).toContainEqual({
      path: "/api/approvals/r1/decision",
      method: "POST",
      body: { decision: "handled" },
    }),
  );
});

test("with nothing waiting on the person, the section is not drawn", async () => {
  inbox = { ...base, requests: [request("r2", "knowledge")], questions: [] };
  serving();
  const view = draw(<BotNeedsYou agentId="expenses" />);
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(view.queryByText("Needs you")).toBeNull();
});

test("only this Bot's suggestions are shown", async () => {
  inbox = { ...base, requests: [], questions: [] };
  serving();
  const view = draw(<SuggestionsInbox agentId="expenses" />);
  expect(await view.findByText(/Chase the March invoice/)).toBeTruthy();
  expect(view.queryByText(/Archive old pages/)).toBeNull();
});

test("a question asked during a hand-off is on the page of the Bot whose conversation it is", async () => {
  inbox = {
    ...base,
    requests: [],
    questions: [
      {
        id: "q1",
        botId: "knowledge",
        conversationBotId: "expenses",
        threadId: "thread",
        question: "Which ledger?",
        createdAt: "2026-10-09T10:00:00Z",
      },
    ],
  };
  serving();
  const handedOn = draw(<BotNeedsYou agentId="expenses" />);
  expect(await handedOn.findByText(/Which ledger\?/)).toBeTruthy();
  cleanup();
  const asked = draw(<BotNeedsYou agentId="knowledge" />);
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(asked.queryByText(/Which ledger\?/)).toBeNull();
});

test("with only a question waiting, Needs you says nothing about approvals and has one heading", async () => {
  inbox = {
    ...base,
    requests: [],
    questions: [
      {
        id: "q1",
        botId: "expenses",
        threadId: "thread",
        question: "Which card?",
        createdAt: "2026-10-09T10:00:00Z",
      },
    ],
  };
  serving();
  const view = draw(<BotNeedsYou agentId="expenses" />);
  await view.findByText(/Which card\?/);
  expect(view.queryByText("No actions need your approval.")).toBeNull();
  expect(view.queryByText("Waiting for you")).toBeNull();
});
