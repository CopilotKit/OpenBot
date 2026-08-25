import { afterEach, expect, test } from "bun:test";
import type { QueryClient } from "@tanstack/react-query";
import {
  deleteChannelMutationOptions,
  setChannelPinnedMutationOptions,
} from "../src/lib/channels/mutations";

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
