import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render } from "@testing-library/react";
import { ChannelItemContent } from "@/components/app-sidebar/channel-item-content";
import { agentListQueryOptions } from "@/lib/agents/queries";
import { settleReactWork } from "./settle-react-work";

/**
 * A conversation in the sidebar says "Working" while its Bot works on it, where its time goes, and shows its time
 * again once the work is done.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

function row(busy: boolean) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  client.setQueryData(agentListQueryOptions().queryKey, []);
  return render(
    <QueryClientProvider client={client}>
      <ChannelItemContent
        busy={busy}
        emphasis="agent"
        lastMessageAt="2m"
        name="Personal Assistant"
        participantIds={["bot-1"]}
        title="Plan the trip"
      />
    </QueryClientProvider>,
  );
}

test("a conversation whose Bot is working says Working where its time goes", () => {
  const view = row(true);
  expect(view.getByText("Working")).toBeTruthy();
  expect(view.queryByText("2m")).toBeNull();
});

test("once the Bot is done, the conversation shows its time again", () => {
  const view = row(false);
  expect(view.getByText("2m")).toBeTruthy();
  expect(view.queryByText("Working")).toBeNull();
});
