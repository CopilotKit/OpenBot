import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, waitFor } from "@testing-library/react";
import { useMarkOpenChannelRead } from "@/lib/channels/mark-read";
import {
  CONVERSATIONS_PATH,
  conversationPage,
  conversationPath,
  noContent,
  problem,
} from "./conversations-api";
import { settleReactWork } from "./settle-react-work";

/**
 * Having a conversation on screen marks it read — a group as much as a one-Bot conversation — so
 * neither its sidebar dot nor the Bots badge stays lit while the person is looking at the reply.
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

const row = (id: string, lastReadAt: string | null) => ({
  id,
  name: "Expense Review, General Assistant",
  agentIds: ["expenses", "general"],
  active: true,
  summary: null,
  lastMessage: "Done.",
  lastMessageAgentId: "expenses",
  lastMessageAt: "2026-10-09T10:00:00.000Z",
  createdAt: "2026-10-09T09:00:00.000Z",
  pinned: false,
  lastReadAt,
});

const writes: string[] = [];
function serving(lastReadAt: string | null) {
  writes.length = 0;
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const path = String(input).split("?")[0];
    if (method !== "GET") {
      writes.push(`${method} ${String(input)}`);
      return path === conversationPath("group-1", "/mark-read")
        ? noContent()
        : problem(404, "Not found.");
    }
    return path === CONVERSATIONS_PATH
      ? Response.json(conversationPage([row("group-1", lastReadAt)]))
      : problem(404, "Not found.");
  }) as unknown as typeof fetch;
}

function Open({ channelId }: { channelId: string }) {
  useMarkOpenChannelRead(channelId);
  return null;
}

function draw() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <Open channelId="group-1" />
    </QueryClientProvider>,
  );
}

test("an open group with a Bot's reply the person has not seen is marked read, once", async () => {
  serving(null);
  draw();
  await waitFor(() =>
    expect(writes).toEqual([
      "POST /api/v2/organizations/default/conversations/group-1/mark-read",
    ]),
  );
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(writes).toHaveLength(1);
});

test("an open group already read is left alone", async () => {
  serving("2026-10-09T11:00:00.000Z");
  draw();
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(writes).toEqual([]);
});
