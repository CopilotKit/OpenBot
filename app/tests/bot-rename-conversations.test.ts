import { afterEach, expect, test } from "bun:test";
import { MutationObserver, QueryClient } from "@tanstack/react-query";
import { updateAgentMutationOptions } from "../src/lib/agents/mutations";
import { channelKeys } from "../src/lib/channels/queries";

/**
 * Renaming a Bot on its Setup page, and the conversations named after it.
 *
 * A conversation is called by its Bot's name, which the server reads from the Bot (see
 * `conversationName` in server/src/channels/routes.ts). The sidebar and the conversation header hold
 * that name in the conversation queries, so a rename that refetched only the Bots left both saying
 * the old name until the page was reloaded. Driven through a real `MutationObserver`, so React Query
 * decides which callbacks run.
 */

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

test("renaming a Bot refetches the conversations, so the sidebar and header show its new name", async () => {
  globalThis.fetch = (async () =>
    Response.json({
      agent: { id: "picked-harness", name: "Personal Assistant F5" },
    })) as unknown as typeof fetch;
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false } },
  });
  queryClient.setQueryData(channelKeys.list(), {
    pages: [{ channels: [], nextCursor: null }],
    pageParams: [""],
  });
  queryClient.setQueryData(channelKeys.detail("channel-1"), {
    id: "channel-1",
    name: "Personal Assistant",
  });

  await new MutationObserver(
    queryClient,
    updateAgentMutationOptions(queryClient),
  ).mutate({
    agentId: "picked-harness",
    input: {
      name: "Personal Assistant F5",
      title: "Everyday life.",
      roleDescription: "Help with everyday errands.",
      visibility: "private",
    },
  });

  expect(queryClient.getQueryState(channelKeys.list())?.isInvalidated).toBe(
    true,
  );
  expect(
    queryClient.getQueryState(channelKeys.detail("channel-1"))?.isInvalidated,
  ).toBe(true);
});
