import { afterEach, expect, test } from "bun:test";
import type { QueryClient } from "@tanstack/react-query";
import {
  hostAccessKeys,
  hostAccessQueryOptions,
  requestHostFolderGrantMutationOptions,
  revokeHostFolderGrantMutationOptions,
  stopHostAccessMutationOptions,
} from "../src/lib/computers/host-access";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

type SeenRequest = { url: string; init: RequestInit | undefined };

function capturingFetch(body: unknown = {}) {
  const seen: SeenRequest[] = [];
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    seen.push({ url: String(url), init });
    return new Response(JSON.stringify(body), {
      status: 200,
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
  return { invalidated, queryClient };
}

function mutationContext(queryClient: QueryClient) {
  return { client: queryClient, meta: undefined };
}

test("host access status has its own stable query key", async () => {
  const seen = capturingFetch({ connected: false, grants: [], pending: [] });
  const options = hostAccessQueryOptions();

  expect([...options.queryKey]).toEqual(["host-access", "status"]);
  const queryFn = options.queryFn;
  if (!queryFn) throw new Error("host access query is missing its fetcher");
  await expect(queryFn({} as never)).resolves.toEqual({
    connected: false,
    grants: [],
    pending: [],
  });
  expect(seen[0]?.url).toBe("/api/host-access");
});

test("requesting a host folder sends only the Bot id", async () => {
  const seen = capturingFetch({ connected: true, grants: [], pending: [] });
  const { invalidated, queryClient } = invalidationRecorder();
  const options = requestHostFolderGrantMutationOptions(queryClient);

  await options.mutationFn?.(
    { botId: "research" },
    mutationContext(queryClient),
  );
  await options.onSuccess?.(
    { connected: true, grants: [], pending: [] },
    { botId: "research" },
    undefined as never,
    undefined as never,
  );

  expect(seen[0]?.url).toBe("/api/host-access/grants");
  expect(seen[0]?.init?.method).toBe("POST");
  expect(JSON.parse(String(seen[0]?.init?.body))).toEqual({
    botId: "research",
  });
  expect(invalidated).toEqual([{ queryKey: hostAccessKeys.all }]);
});

test("revoking and stopping host access use their dedicated endpoints", async () => {
  const seen = capturingFetch();
  const { queryClient } = invalidationRecorder();

  const revoke = revokeHostFolderGrantMutationOptions(queryClient);
  await revoke.mutationFn?.(
    { grantId: "grant/with/slash" },
    mutationContext(queryClient),
  );

  const stop = stopHostAccessMutationOptions(queryClient);
  await stop.mutationFn?.(undefined, mutationContext(queryClient));

  expect(seen.map((request) => [request.url, request.init?.method])).toEqual([
    ["/api/host-access/grants/grant%2Fwith%2Fslash", "DELETE"],
    ["/api/host-access/stop", "POST"],
  ]);
});
