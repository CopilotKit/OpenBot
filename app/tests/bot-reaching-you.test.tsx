import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { ReachingYou } from "@/components/delivery/reaching-you";
import { settleReactWork } from "./settle-react-work";

/** A Bot's Reaching you page: where this Bot's conversations continue outside OpenBot. */

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

const channel = (id: string, name: string, agentIds: string[]) => ({
  id,
  name,
  agentIds,
  active: true,
  summary: null,
  lastMessage: null,
  lastMessageAgentId: null,
  createdAt: "2026-10-09T10:00:00Z",
  pinned: false,
  lastReadAt: null,
});

const binding = (id: string, agentId: string, address: string) => ({
  id,
  transport: "slack",
  channelId: `channel-${agentId}`,
  agentId,
  address,
  enabled: true,
});

const writes: { request: string; body: unknown }[] = [];
function serving() {
  writes.length = 0;
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (method !== "GET") {
      writes.push({
        request: `${method} ${url}`,
        body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
      });
      return Response.json({
        platform: "slack",
        code: "abc",
        command: "link abc",
        expiresInMinutes: 10,
      });
    }
    if (url.startsWith("/api/delivery")) {
      return Response.json({
        bindings: [
          binding("b1", "expenses", "finance-bot-dm"),
          binding("b2", "knowledge", "docs-bot-dm"),
        ],
        devices: [],
        deliveries: [],
        available: { slack: true, teams: false, sms: false, push: false },
      });
    }
    if (url.startsWith("/api/channels")) {
      return Response.json({
        channels: [
          channel("channel-expenses", "Finance desk", ["expenses"]),
          channel("channel-knowledge", "Docs desk", ["knowledge"]),
        ],
        nextCursor: null,
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

function draw() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <ReachingYou agentId="expenses" />
    </QueryClientProvider>,
  );
}

test("only this Bot's destinations are listed", async () => {
  serving();
  const view = draw();
  expect(await view.findByText(/^Slack/)).toBeTruthy();
  expect(view.getAllByRole("button", { name: "Disconnect" })).toHaveLength(1);
});

test("linking Slack needs only a conversation, and warns that it moves the account", async () => {
  serving();
  const view = draw();
  await view.findByRole("button", { name: "Disconnect" });
  expect(view.queryByRole("combobox", { name: /^Bot/ })).toBeNull();
  expect(view.getByText(/Linking it here moves it/)).toBeTruthy();
  const conversation = view.getByRole("combobox", { name: /^Conversation/ });
  const options = [...conversation.querySelectorAll("option")].map(
    (option) => option.textContent,
  );
  expect(options).not.toContain("Docs desk");
  fireEvent.change(conversation, { target: { value: "channel-expenses" } });
  fireEvent.click(view.getByRole("button", { name: "Link Slack" }));
  await waitFor(() =>
    expect(writes).toContainEqual({
      request: "POST /api/delivery/opentag/start",
      body: {
        channelId: "channel-expenses",
        agentId: "expenses",
        platform: "slack",
      },
    }),
  );
});

test("nothing can be linked until a conversation is chosen", async () => {
  serving();
  const view = draw();
  await view.findByRole("button", { name: "Disconnect" });
  expect(
    view.getByRole("button", { name: "Link Slack" }).hasAttribute("disabled"),
  ).toBe(true);
  fireEvent.change(view.getByRole("combobox", { name: /^Conversation/ }), {
    target: { value: "channel-expenses" },
  });
  expect(
    view.getByRole("button", { name: "Link Slack" }).hasAttribute("disabled"),
  ).toBe(false);
});
