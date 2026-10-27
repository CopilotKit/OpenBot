import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { ConversationActions } from "@/components/channels/conversation-actions";
import type { ChannelSummary } from "@/lib/channels/queries";
import { settleReactWork } from "./settle-react-work";

/**
 * Pin and Delete in the Bot panel beside an open conversation. Whether it is pinned is read from
 * the sidebar's list, and leaving the conversation is the caller's, so these tests serve the list
 * and assert on the requests and on when `leave` ran.
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

function summary(id: string, pinned: boolean): ChannelSummary {
  return {
    id,
    name: "Expenses",
    agentIds: ["expenses"],
    threadId: `thread-${id}`,
    active: true,
    lastMessageAt: null,
    summary: null,
    lastMessage: null,
    lastMessageAgentId: null,
    createdAt: "2026-10-01T00:00:00.000Z",
    pinned,
    lastReadAt: null,
  };
}

const requests: string[] = [];
function serving(channels: ChannelSummary[]) {
  requests.length = 0;
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    requests.push(`${method} ${String(input)}`);
    if (method === "GET") return Response.json({ channels, nextCursor: null });
    return new Response(null, { status: 204 });
  }) as unknown as typeof fetch;
}

function draw(leave: () => Promise<unknown> = async () => {}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <ConversationActions channelId="c1" leave={leave} name="Expenses" />
    </QueryClientProvider>,
  );
}

test("a conversation that is not pinned offers Pin, and pinning asks for it", async () => {
  serving([summary("c1", false)]);
  const view = draw();

  const pin = await view.findByRole("button", { name: "Pin conversation" });
  await waitFor(() => expect(pin.hasAttribute("disabled")).toBe(false));
  fireEvent.click(pin);

  await waitFor(() => expect(requests).toContain("PUT /api/channels/c1/pin"));
});

test("a pinned conversation offers Unpin", async () => {
  serving([summary("c1", true)]);
  const view = draw();

  expect(
    await view.findByRole("button", { name: "Unpin conversation" }),
  ).toBeTruthy();
});

test("Delete is confirmed, and leaves the conversation before deleting it", async () => {
  serving([summary("c1", false)]);
  const order: string[] = [];
  const view = draw(async () => {
    order.push(`leave after ${requests.length} requests`);
  });

  fireEvent.click(
    await view.findByRole("button", { name: "Delete conversation…" }),
  );
  expect(requests).not.toContain("DELETE /api/channels/c1");

  fireEvent.click(await view.findByRole("button", { name: "Delete" }));

  await waitFor(() => expect(requests).toContain("DELETE /api/channels/c1"));
  expect(order).toEqual(["leave after 1 requests"]);
});
