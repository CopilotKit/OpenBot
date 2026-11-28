import { afterEach, beforeEach, expect, test } from "bun:test";
import { type InfiniteData, QueryClient } from "@tanstack/react-query";
import { isWorking } from "../src/components/app-sidebar/conversations-panel";
import { forgetHeardBusy, resetHeldBusy } from "../src/lib/channels/held-busy";
import { setChannelBusy } from "../src/lib/channels/mutations";
import {
  type ChannelPage,
  type ChannelSummary,
  channelKeys,
  channelListQueryOptions,
} from "../src/lib/channels/queries";
import { applyToRoster } from "../src/lib/channels/use-channel-events";
import { delegatingConversationsQueryOptions } from "../src/lib/tasks/queries";
import {
  CONVERSATIONS_PATH,
  conversationPage,
  conversationPath,
  noContent,
  TASKS_PATH,
  taskOf,
} from "./conversations-api";
import { busyEvent, listedRow } from "./roster-rows";

/*
 * Where a conversation's Working comes from, besides a turn the list was told of: a turn this tab
 * runs, which it knows the start and end of whatever the socket does, and work the Bot handed to a
 * task, which goes on after its own turn has ended.
 */

const originalFetch = globalThis.fetch;
let tasks: unknown[] = [];

beforeEach(() => {
  resetHeldBusy();
  tasks = [];
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://openbot.invalid");
      if (url.pathname === CONVERSATIONS_PATH)
        return Response.json(
          conversationPage([listedRow("followups"), listedRow("hn")]),
        );
      if (url.pathname === TASKS_PATH)
        return Response.json({ tasks, nextCursor: null });
      if (
        (init?.method ?? "GET").toUpperCase() === "POST" &&
        url.pathname === conversationPath("followups", "/signal-busy")
      )
        return noContent();
      throw new Error(`Nothing answers ${url.pathname} here.`);
    },
    { preconnect: originalFetch.preconnect },
  );
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  resetHeldBusy();
});

function client() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function listed(queryClient: QueryClient, channelId: string): ChannelSummary {
  const found = queryClient
    .getQueryData<InfiniteData<ChannelPage>>(channelKeys.list())
    ?.pages.flatMap((page) => page.channels)
    .find((channel) => channel.id === channelId);
  if (!found) throw new Error(`The list does not hold ${channelId}.`);
  return found;
}

const readAgain = (queryClient: QueryClient) =>
  queryClient.refetchQueries({ queryKey: channelKeys.list() });

test("a turn this tab runs stays Working across a reconnect; one only heard of is let go", async () => {
  const queryClient = client();
  await queryClient.fetchInfiniteQuery(channelListQueryOptions());

  // This tab's own turn in one conversation, another tab's in the other.
  await setChannelBusy({ channelId: "followups", busy: true });
  applyToRoster(queryClient, busyEvent("followups", true));
  applyToRoster(queryClient, busyEvent("hn", true));

  // The socket drops and comes back: the other tab's end may have been said while it was down.
  forgetHeardBusy();
  await readAgain(queryClient);
  expect(isWorking(listed(queryClient, "followups"), [])).toBe(true);
  expect(isWorking(listed(queryClient, "hn"), [])).toBe(false);

  await setChannelBusy({ channelId: "followups", busy: false });
  applyToRoster(queryClient, busyEvent("followups", false));
  await readAgain(queryClient);
  expect(isWorking(listed(queryClient, "followups"), [])).toBe(false);
  queryClient.clear();
});

test("a conversation whose Bot handed work to a task says Working until the task is done", async () => {
  const queryClient = client();
  await queryClient.fetchInfiniteQuery(channelListQueryOptions());
  const followups = listed(queryClient, "followups");
  const hn = listed(queryClient, "hn");
  const task = (status: string) =>
    taskOf({
      id: "task-1",
      agentId: "bot-1",
      channelId: "task-conversation",
      threadId: "task-thread",
      title: "Find the prospect follow-ups",
      why: null,
      origin: "delegated",
      suggestionId: null,
      sourceApp: null,
      sourceLink: null,
      originChannelId: "followups",
      status,
      failure: null,
      failedAt: null,
      next: null,
      resolvedAt: null,
      createdAt: "2026-11-25T18:52:00.000Z",
      updatedAt: "2026-11-25T18:52:00.000Z",
    });
  const options = delegatingConversationsQueryOptions();
  const delegating = async () => {
    const read = await queryClient.fetchQuery({ ...options, staleTime: 0 });
    return options.select ? options.select(read) : [];
  };

  // The Bot's own turn ended on "On it"; its task works on in a conversation of its own.
  tasks = [task("working")];
  expect(isWorking(followups, await delegating())).toBe(true);
  expect(isWorking(hn, await delegating())).toBe(false);

  // Done, waiting on the person, or couldn't finish: nothing is working any more.
  for (const status of ["ready_for_review", "needs_input", "failed"]) {
    tasks = [task(status)];
    expect(isWorking(followups, await delegating())).toBe(false);
  }
  queryClient.clear();
});
