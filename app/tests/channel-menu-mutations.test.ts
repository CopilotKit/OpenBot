import { afterEach, expect, test } from "bun:test";
import { QueryClient, type InfiniteData } from "@tanstack/react-query";
import {
  deleteChannelMutationOptions,
  markChannelReadMutationOptions,
  setChannelPinnedMutationOptions,
} from "../src/lib/channels/mutations";
import { channelKeys, type ChannelPage } from "../src/lib/channels/queries";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

type SeenRequest = { url: string; init: RequestInit | undefined };

function capturingFetch(status: number, body: unknown) {
  const seen: SeenRequest[] = [];
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    seen.push({ url: String(url), init });
    return new Response(body === undefined ? null : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return seen;
}

function invalidationRecorder() {
  const invalidated: unknown[] = [];
  const queryClient = {
    invalidateQueries: async (filter: unknown) => {
      invalidated.push(filter);
    },
  } as unknown as QueryClient;
  return { queryClient, invalidated };
}

test("pinning PUTs the flag to the channel's pin route and invalidates the roster", async () => {
  const seen = capturingFetch(200, { pinned: true });
  const { queryClient, invalidated } = invalidationRecorder();
  const options = setChannelPinnedMutationOptions(queryClient);

  await options.mutationFn?.({ channelId: "channel-1", pinned: true });
  await options.onSuccess?.(
    undefined as never,
    { channelId: "channel-1", pinned: true },
    undefined as never,
    undefined as never,
  );

  expect(seen).toHaveLength(1);
  expect(seen[0]?.url).toBe("/api/channels/channel-1/pin");
  expect(seen[0]?.init?.method).toBe("PUT");
  expect(JSON.parse(String(seen[0]?.init?.body))).toEqual({ pinned: true });
  expect(invalidated).toEqual([{ queryKey: ["channels"] }]);
});

test("deleting sends DELETE to the channel route and invalidates the roster", async () => {
  const seen = capturingFetch(204, undefined);
  const { queryClient, invalidated } = invalidationRecorder();
  const options = deleteChannelMutationOptions(queryClient);

  await options.mutationFn?.("channel-1");
  await options.onSuccess?.(
    undefined as never,
    "channel-1",
    undefined as never,
    undefined as never,
  );

  expect(seen).toHaveLength(1);
  expect(seen[0]?.url).toBe("/api/channels/channel-1");
  expect(seen[0]?.init?.method).toBe("DELETE");
  expect(invalidated).toEqual([{ queryKey: ["channels", "list"] }]);
});

test("a refused delete surfaces the server's sentence", async () => {
  capturingFetch(409, {
    error:
      "This channel is defined by the deployment package, so it cannot be deleted here.",
  });
  const { queryClient } = invalidationRecorder();
  const options = deleteChannelMutationOptions(queryClient);

  await expect(options.mutationFn?.("channel-1")).rejects.toThrow(
    "This channel is defined by the deployment package, so it cannot be deleted here.",
  );
});

test("marking read PUTs the read route and patches lastReadAt in place", async () => {
  const seen = capturingFetch(204, undefined);
  const queryClient = new QueryClient();
  queryClient.setQueryData(channelKeys.list(), {
    pages: [
      {
        channels: [
          {
            id: "channel-1",
            name: "Assistant channel",
            agentIds: ["agent-1"],
            threadId: "thread-1",
            active: true,
            lastMessage: "hello",
            lastMessageAt: "2026-08-25T12:00:00.000Z",
            lastMessageAgentId: "agent-1",
            createdAt: "2026-08-25T11:00:00.000Z",
            pinned: false,
            lastReadAt: null,
          },
        ],
        nextCursor: null,
      },
    ],
    pageParams: [""],
  } satisfies InfiniteData<ChannelPage>);
  const options = markChannelReadMutationOptions(queryClient);

  options.onMutate?.("channel-1");
  await options.mutationFn?.("channel-1");

  expect(seen).toHaveLength(1);
  expect(seen[0]?.url).toBe("/api/channels/channel-1/read");
  expect(seen[0]?.init?.method).toBe("PUT");
  const patched = queryClient.getQueryData<InfiniteData<ChannelPage>>(
    channelKeys.list(),
  );
  // The dot clears from the cache before the wire answered, and nothing was invalidated:
  // there is no onSuccess to queue a refetch that would race the socket's own patches.
  expect(patched?.pages[0]?.channels[0]?.lastReadAt).not.toBeNull();
  expect(options.onSuccess).toBeUndefined();
});

test("a message stamped by a clock ahead of ours still reads as seen after marking", async () => {
  capturingFetch(204, undefined);
  const queryClient = new QueryClient();
  const futureLastMessageAt = new Date(Date.now() + 60_000).toISOString();
  queryClient.setQueryData(channelKeys.list(), {
    pages: [
      {
        channels: [
          {
            id: "channel-1",
            name: "Assistant channel",
            agentIds: ["agent-1"],
            threadId: "thread-1",
            active: true,
            lastMessage: "hello",
            lastMessageAt: futureLastMessageAt,
            lastMessageAgentId: "agent-1",
            createdAt: "2026-08-25T11:00:00.000Z",
            pinned: false,
            lastReadAt: null,
          },
        ],
        nextCursor: null,
      },
    ],
    pageParams: [""],
  } satisfies InfiniteData<ChannelPage>);
  const options = markChannelReadMutationOptions(queryClient);

  options.onMutate?.("channel-1");

  const patched = queryClient.getQueryData<InfiniteData<ChannelPage>>(
    channelKeys.list(),
  );
  const row = patched?.pages[0]?.channels[0];
  // A reader's clock running behind the writer's must not leave the row still reading as unseen:
  // the patched lastReadAt has to catch up to (or pass) lastMessageAt, not just "now".
  expect(row?.lastReadAt).not.toBeNull();
  expect((row?.lastReadAt as string) >= futureLastMessageAt).toBe(true);
});
