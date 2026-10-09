import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, waitFor } from "@testing-library/react";
import { useMarkOpenChannelRead } from "@/lib/channels/mark-read";
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
    if (method !== "GET") {
      writes.push(`${method} ${String(input)}`);
      return new Response(null, { status: 204 });
    }
    return Response.json({
      channels: [row("group-1", lastReadAt)],
      nextCursor: null,
    });
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
    expect(writes).toEqual(["PUT /api/channels/group-1/read"]),
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
