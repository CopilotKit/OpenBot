import { afterEach, beforeEach, expect, test } from "bun:test";
import { type InfiniteData, QueryClient } from "@tanstack/react-query";
import {
  type ChannelPage,
  channelKeys,
  channelListQueryOptions,
} from "../src/lib/channels/queries";
import { applyToRoster } from "../src/lib/channels/use-channel-events";
import { CONVERSATIONS_PATH, conversationPage } from "./conversations-api";
import { busyEvent, listedRow } from "./roster-rows";

/*
 * A conversation's row in the list says Working for as long as its Bot works, however long that is
 * and whatever reads the list again meanwhile.
 *
 * Found on OpenBot Cloud: a Bot ran three subtasks after the person gave it Slack. The conversation
 * said "Working on 3 subtasks…"; its row said "1m". Giving the app read every query again, and the
 * server's answer for a conversation whose turn runs in the person's browser says nothing of busy,
 * so the read put out the dot the turn's busy event had lit.
 */

const originalFetch = globalThis.fetch;
/** What the next read of the list waits on before it answers, when a test holds it. */
let held: Promise<void> | null = null;

beforeEach(() => {
  held = null;
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL) => {
      const url = new URL(String(input), "http://openbot.invalid");
      if (url.pathname !== CONVERSATIONS_PATH)
        throw new Error(`Nothing answers ${url.pathname} here.`);
      const wait = held;
      if (wait) await wait;
      return Response.json(
        conversationPage([listedRow("followups"), listedRow("hn")]),
      );
    },
    { preconnect: originalFetch.preconnect },
  );
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function client() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

/** Whether the list, as the sidebar holds it, draws this conversation's row as Working. */
function working(queryClient: QueryClient, channelId: string): boolean {
  const data = queryClient.getQueryData<InfiniteData<ChannelPage>>(
    channelKeys.list(),
  );
  const found = data?.pages
    .flatMap((page) => page.channels)
    .find((channel) => channel.id === channelId);
  if (!found) throw new Error(`The list does not hold ${channelId}.`);
  return (found.busy ?? false) || (found.work?.length ?? 0) > 0;
}

const readAgain = (queryClient: QueryClient) =>
  queryClient.refetchQueries({ queryKey: channelKeys.list() });

test("a conversation stays Working when the list is read again while its Bot works, and stops when it is done", async () => {
  const queryClient = client();
  await queryClient.fetchInfiniteQuery(channelListQueryOptions());
  expect(working(queryClient, "followups")).toBe(false);

  applyToRoster(queryClient, busyEvent("followups", true));
  expect(working(queryClient, "followups")).toBe(true);

  // Giving an app reads every query again; the server's answer says nothing of the turn.
  await readAgain(queryClient);
  expect(working(queryClient, "followups")).toBe(true);
  // Only the conversation the turn runs in.
  expect(working(queryClient, "hn")).toBe(false);

  applyToRoster(queryClient, busyEvent("followups", false));
  expect(working(queryClient, "followups")).toBe(false);
  await readAgain(queryClient);
  expect(working(queryClient, "followups")).toBe(false);
  queryClient.clear();
});

test("a read already on its way when the turn starts does not put the row out when it lands", async () => {
  const queryClient = client();
  await queryClient.fetchInfiniteQuery(channelListQueryOptions());

  let answer = () => {};
  held = new Promise<void>((resolve) => {
    answer = resolve;
  });
  // Every query read again as the app is given, and the card carries the task on at once.
  const reading = readAgain(queryClient);
  applyToRoster(queryClient, busyEvent("followups", true));
  held = null;
  answer();
  await reading;
  // And the read once more that a patch made mid-read asks for (`readAgainWhenLanded`).
  await new Promise((resolve) => setTimeout(resolve, 0));
  await readAgain(queryClient);
  expect(working(queryClient, "followups")).toBe(true);

  applyToRoster(queryClient, busyEvent("followups", false));
  await readAgain(queryClient);
  expect(working(queryClient, "followups")).toBe(false);
  queryClient.clear();
});
