import {
  afterAll,
  afterEach,
  beforeAll,
  expect,
  jest,
  setSystemTime,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
} from "@tanstack/react-query";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { ChannelWorkRows } from "@/components/channels/channel-work";
import { formatElapsed } from "@/components/channels/progress-row";
import {
  type AgentChannel,
  type ChannelWork,
  channelKeys,
  channelQueryOptions,
} from "@/lib/channels/queries";
import { applyChannelWork } from "@/lib/channels/use-channel-events";
import { settleReactWork } from "./settle-react-work";

/**
 * The row a conversation shows while it waits on work nobody's browser is running: "Asking Ana…
 * 0:12" for a Bot its Bot asked, and the same for a routine. Driven by the server's list, so it
 * has to appear from a fetched channel as well as from a socket event, tick while it is up, and go
 * when the list empties.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(() => {
  cleanup();
  jest.useRealTimers();
  setSystemTime();
});
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
});

const NOW = new Date("2026-10-26T10:00:12.000Z");

const asking = (overrides: Partial<ChannelWork> = {}): ChannelWork =>
  ({
    kind: "handoff",
    key: "hop-1",
    botId: "ana",
    botName: "Ana",
    since: "2026-10-26T10:00:00.000Z",
    ...overrides,
  }) as ChannelWork;

test("says who was asked and for how long", () => {
  setSystemTime(NOW);

  const view = render(<ChannelWorkRows work={[asking()]} />);

  const row = view.getByTestId("progress-row");
  expect(row.textContent).toBe("Asking Ana…0:12");
  // Announced as progress, and only by its words: the clock is hidden from a screen reader.
  expect(row.getAttribute("role")).toBe("status");
  expect(row.querySelector("[aria-hidden='true']")?.textContent).toBe("0:12");
});

test("the clock moves while the row is up", () => {
  jest.useFakeTimers();
  setSystemTime(NOW);
  const view = render(<ChannelWorkRows work={[asking()]} />);

  // The fake clock moves `Date.now()` with the timers, as a real second would.
  act(() => {
    jest.advanceTimersByTime(3_000);
  });

  expect(view.getByTestId("progress-row").textContent).toBe("Asking Ana…0:15");
});

test("prefers the name the person knows the Bot by", () => {
  setSystemTime(NOW);

  const view = render(
    <ChannelWorkRows
      nameOf={(botId) => (botId === "ana" ? "Ana Research" : undefined)}
      work={[asking()]}
    />,
  );

  expect(view.getByTestId("progress-row").textContent).toContain(
    "Asking Ana Research…",
  );
});

test("one row for each Bot asked, and one for a routine", () => {
  setSystemTime(NOW);

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
    "Asking Ana…0:12",
    "Asking another Bot…0:12",
    "Assistant is running a routine…1:12",
  ]);
});

test("goes when the list empties", () => {
  setSystemTime(NOW);
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
  setSystemTime(NOW);
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
    expect(view.getByTestId("progress-row").textContent).toBe(
      "Asking Ana…0:12",
    );
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

test("the clock reads minutes, then hours, and never runs backwards", () => {
  expect(formatElapsed(12_000)).toBe("0:12");
  expect(formatElapsed(245_000)).toBe("4:05");
  expect(formatElapsed(3_727_000)).toBe("1:02:07");
  expect(formatElapsed(-4_000)).toBe("0:00");
});
