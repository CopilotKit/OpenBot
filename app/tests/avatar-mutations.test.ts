import { afterEach, expect, test } from "bun:test";
import type { QueryClient } from "@tanstack/react-query";
import { updateAgentAvatarMutationOptions } from "@/lib/agents/mutations";
import { updateCurrentUserAvatarMutationOptions } from "@/lib/auth/mutations";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

function harness(response: unknown) {
  const requests: { url: string; init?: RequestInit }[] = [];
  const invalidated: unknown[] = [];
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    requests.push({ url: String(url), init });
    return Response.json(response);
  }) as typeof fetch;
  const queryClient = {
    invalidateQueries: async (filter: unknown) => {
      invalidated.push(filter);
    },
  } as unknown as QueryClient;
  return { invalidated, queryClient, requests };
}

test("a coworker upload writes the avatar route and refreshes profile and roster images", async () => {
  const { invalidated, queryClient, requests } = harness({ agent: {} });
  const options = updateAgentAvatarMutationOptions(queryClient);
  const variables = {
    agentId: "agent-1",
    image: "data:image/png;base64,image",
  };

  await options.mutationFn?.(variables);
  await options.onSuccess?.(
    {} as never,
    variables,
    undefined as never,
    undefined as never,
  );

  expect(requests[0]?.url).toBe("/api/agents/agent-1/avatar");
  expect(requests[0]?.init?.method).toBe("PUT");
  expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({
    image: variables.image,
  });
  expect(invalidated).toEqual([
    { queryKey: ["agents"] },
    { queryKey: ["channels"] },
  ]);
});

test("a person upload writes their own route and refreshes the current-user avatar", async () => {
  const { invalidated, queryClient, requests } = harness({ avatar: {} });
  const options = updateCurrentUserAvatarMutationOptions(queryClient);

  await options.mutationFn?.(null);
  await options.onSuccess?.(
    {} as never,
    null,
    undefined as never,
    undefined as never,
  );

  expect(requests[0]?.url).toBe("/api/me/avatar");
  expect(requests[0]?.init?.method).toBe("PUT");
  expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({ image: null });
  expect(invalidated).toEqual([{ queryKey: ["auth", "current-user"] }]);
});
