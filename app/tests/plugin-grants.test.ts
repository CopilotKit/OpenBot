import { afterEach, expect, test } from "bun:test";
import type { QueryClient } from "@tanstack/react-query";
import {
  grantPlugin,
  setPluginGrantMutationOptions,
} from "../src/lib/plugins/mutations";

/**
 * Granting a batch of tools, and what a batch is allowed to cost.
 *
 * The admin dialog grants a tool per Bot per tick, so choosing two Bots and twelve tools is
 * twenty-four writes. Every one of them used to go through the grant mutation, which invalidates
 * every plugin query and waits for the refetch — so most of the wait was re-reading a list hidden
 * behind the dialog. `grantPlugin` is the write on its own, and the caller refetches once at the
 * end. These pin that the write is unchanged and that the refetch is not attached to it.
 */

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

/*
 * The context TanStack Query hands a mutation callback alongside its variables. These tests drive
 * the callbacks directly rather than through a MutationObserver, so they have to supply it. Both
 * fields are the real thing rather than a stand-in: `meta` is undefined exactly as it is for a
 * mutation declared without one, and `mutationKey` is optional and genuinely absent, because none
 * of these options factories sets one.
 */
function mutationContext(queryClient: QueryClient) {
  return { client: queryClient, meta: undefined };
}

test("one grant is one POST of the three things it joins", async () => {
  const seen = capturingFetch(200, {});

  await grantPlugin({ agentId: "agent-1", kind: "mcp", ref: "notion/search" });

  expect(seen).toHaveLength(1);
  expect(seen[0]?.url).toBe("/api/plugins/grants");
  expect(seen[0]?.init?.method).toBe("POST");
  expect(JSON.parse(String(seen[0]?.init?.body))).toEqual({
    agentId: "agent-1",
    kind: "mcp",
    ref: "notion/search",
  });
});

test("a batch of grants is N grant requests and nothing else", async () => {
  const seen = capturingFetch(200, {});

  for (const ref of ["notion/search", "notion/fetch", "notion/create"]) {
    await grantPlugin({ agentId: "agent-1", kind: "mcp", ref });
  }

  // Three writes, and no read in between: the refetch belongs to the caller, once, at the end.
  expect(seen.map((request) => request.init?.method)).toEqual([
    "POST",
    "POST",
    "POST",
  ]);
});

test("a refused grant carries the server's own sentence", async () => {
  capturingFetch(403, { error: "That Agent is defined by the package." });

  await expect(
    grantPlugin({ agentId: "agent-1", kind: "mcp", ref: "notion/search" }),
  ).rejects.toThrow("That Agent is defined by the package.");
});

test("granting one on its own still carries its refetch", async () => {
  const seen = capturingFetch(200, {});
  const { queryClient, invalidated } = invalidationRecorder();
  const options = setPluginGrantMutationOptions(queryClient);

  await options.mutationFn?.(
    {
      agentId: "agent-1",
      granted: true,
      kind: "mcp",
      ref: "notion/search",
    },
    mutationContext(queryClient),
  );
  await options.onSuccess?.(
    undefined as never,
    {
      agentId: "agent-1",
      granted: true,
      kind: "mcp",
      ref: "notion/search",
    },
    undefined as never,
    undefined as never,
  );

  expect(seen).toHaveLength(1);
  expect(invalidated).toEqual([{ queryKey: ["plugins"] }]);
});
