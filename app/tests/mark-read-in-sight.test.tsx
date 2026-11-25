import { afterAll, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { useMarkOpenChannelRead } from "@/lib/channels/mark-read";
import { type ChannelSummary, channelKeys } from "@/lib/channels/queries";
import { settleReactWork } from "./settle-react-work";

/*
 * A conversation open in OpenBot is marked read only while the person can see it: its page shown and
 * its window focused. One left open behind other windows, or in OpenBot Desktop while the person is
 * away, keeps the Bot's answer unread, which is what has the server tell their phone about it.
 */

const nativeFetch = globalThis.fetch;
const marked: string[] = [];
let focused = false;

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/" });
  document.hasFocus = () => focused;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.includes("/mark-read")) marked.push(url);
    return new Response(null, { status: 204 });
  }) as typeof fetch;
});
afterAll(async () => {
  cleanup();
  globalThis.fetch = nativeFetch;
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const unread: ChannelSummary = {
  id: "c1",
  name: "",
  agentIds: ["a"],
  threadId: "t1",
  active: true,
  lastMessageAt: "2026-11-25T10:00:00.000Z",
  summary: null,
  lastMessage: "The report is ready.",
  lastMessageAgentId: "a",
  createdAt: "2026-11-25T09:00:00.000Z",
  pinned: false,
  lastReadAt: "2026-11-25T09:30:00.000Z",
} as ChannelSummary;

test("an answer in a conversation left open out of sight stays unread until the person comes back", async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { staleTime: Infinity, retry: false } },
  });
  client.setQueryData(channelKeys.list(), {
    pages: [{ channels: [unread], nextCursor: null }],
    pageParams: [""],
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  renderHook(() => useMarkOpenChannelRead("c1"), { wrapper });
  await settleReactWork();
  expect(marked).toEqual([]);

  focused = true;
  act(() => {
    window.dispatchEvent(new Event("focus"));
  });
  await waitFor(() => expect(marked).toHaveLength(1));
  expect(marked[0]).toContain("/conversations/c1/mark-read");
});
