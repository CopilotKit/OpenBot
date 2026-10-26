import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
} from "@tanstack/react-query";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { ChannelWorkRows } from "@/components/channels/channel-work";
import {
  type AgentChannel,
  type ChannelWork,
  channelKeys,
  channelQueryOptions,
} from "@/lib/channels/queries";
import { applyChannelWork } from "@/lib/channels/use-channel-events";
import { settleReactWork } from "./settle-react-work";

/**
 * The row a conversation shows while it waits on work nobody's browser is running: the Bot's avatar
 * and "Asking Ana…" for a Bot its Bot asked, and the same for a routine. Driven by the server's
 * list, so it has to appear from a fetched channel as well as from a socket event, and go when the
 * list empties.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(() => {
  cleanup();
});
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
});

const asking = (overrides: Partial<ChannelWork> = {}): ChannelWork =>
  ({
    kind: "handoff",
    key: "hop-1",
    botId: "ana",
    botName: "Ana",
    since: "2026-10-26T10:00:00.000Z",
    ...overrides,
  }) as ChannelWork;

test("says who was asked, with their avatar and no clock", () => {
  const view = render(<ChannelWorkRows work={[asking()]} />);

  const row = view.getByTestId("progress-row");
  expect(row.textContent).toBe("Asking Ana…");
  expect(row.getAttribute("role")).toBe("status");
  // The avatar is decoration beside a label that already names the Bot, so it is announced once.
  const avatar = row.querySelector("[aria-hidden='true'] [role='img']");
  expect(avatar?.getAttribute("aria-label")).toBe("Ana");
  expect(row.querySelector("svg")).not.toBeNull();
});

test("prefers the name and avatar the person knows the Bot by", () => {
  const view = render(
    <ChannelWorkRows
      botOf={(botId) =>
        botId === "ana"
          ? { name: "Ana Research", avatarSeed: "seed-ana" }
          : undefined
      }
      work={[asking()]}
    />,
  );
  const known = view.getByTestId("progress-row").innerHTML;
  cleanup();
  const unknown = render(<ChannelWorkRows work={[asking()]} />).getByTestId(
    "progress-row",
  ).innerHTML;

  expect(known).toContain("Asking Ana Research…");
  // Drawn from the Bot's own seed, so it is the same face the Bot has everywhere else.
  expect(known.replace("Ana Research", "Ana")).not.toBe(unknown);
});

test("one row for each Bot asked, and one for a routine", () => {
  const view = render(
    <ChannelWorkRows
      work={[
        asking(),
        asking({ key: "hop-2", botId: "ben", botName: null }),
        {
          kind: "routine",
          key: "run-1",
          routineId: "routine-1",
          botId: "assistant",
          botName: "Assistant",
          since: "2026-10-26T09:59:00.000Z",
        },
      ]}
    />,
  );

  expect(
    view.getAllByTestId("progress-row").map((row) => row.textContent),
  ).toEqual([
    "Asking Ana…",
    "Asking another Bot…",
    "Assistant is running a routine…",
  ]);
});

test("goes when the list empties", () => {
  const view = render(<ChannelWorkRows work={[asking()]} />);

  view.rerender(<ChannelWorkRows work={[]} />);

  expect(view.queryByTestId("progress-row")).toBeNull();
  expect(view.queryByTestId("channel-work")).toBeNull();
});

/*
 * A reload is a fetch of the channel, not a socket event. The list has to come back with it, or a
 * conversation a Bot is still answering in looks finished to anybody who refreshed.
 */
test("comes back from the channel read after a reload", async () => {
  global.fetch = (async (input: RequestInfo | URL) => {
    if (String(input) === "/api/channels/channel-1") {
      return Response.json({
        channel: {
          id: "channel-1",
          name: "Assistant",
          agentIds: ["assistant"],
          threadId: "thread-1",
          active: true,
          lastMessageAt: null,
          work: [asking()],
        },
      });
    }
    return Response.json({ error: "unexpected" }, { status: 500 });
  }) as typeof fetch;
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  function Conversation() {
    const channel = useQuery(channelQueryOptions("channel-1"));
    return <ChannelWorkRows work={channel.data?.work} />;
  }

  const view = render(
    <QueryClientProvider client={queryClient}>
      <Conversation />
    </QueryClientProvider>,
  );

  await waitFor(() => {
    expect(view.getByTestId("progress-row").textContent).toBe("Asking Ana…");
  });

  // The socket then says the answer is being given, and the row goes.
  act(() => {
    queryClient.setQueryData(
      channelKeys.detail("channel-1"),
      (channel: AgentChannel | undefined) =>
        applyChannelWork(channel, {
          channelId: "channel-1",
          lastMessage: null,
          lastMessageAt: null,
          lastMessageAgentId: null,
          work: [],
        }),
    );
  });
  await waitFor(() => {
    expect(view.queryByTestId("progress-row")).toBeNull();
  });
});

test("an event with no list leaves the conversation's list alone", () => {
  const channel: AgentChannel = {
    id: "channel-1",
    name: "Assistant",
    agentIds: [],
    threadId: "thread-1",
    active: true,
    lastMessageAt: null,
    work: [asking()],
  };

  expect(
    applyChannelWork(channel, {
      channelId: "channel-1",
      lastMessage: null,
      lastMessageAt: null,
      lastMessageAgentId: null,
      busy: true,
    }),
  ).toBe(channel);
  // And the same list again changes nothing either, so nothing re-renders.
  expect(
    applyChannelWork(channel, {
      channelId: "channel-1",
      lastMessage: null,
      lastMessageAt: null,
      lastMessageAgentId: null,
      work: [asking()],
    }),
  ).toBe(channel);
});
