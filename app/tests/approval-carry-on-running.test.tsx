import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import type { Message } from "@ag-ui/core";
import { CopilotKitProvider } from "@copilotkit/react-core/v2";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ChannelChat } from "@/components/channels/channel-chat";
import {
  type ApprovalInboxData,
  carryingOnAfterApproval,
} from "@/lib/approvals";
import { type AgentChannel, channelKeys } from "@/lib/channels/queries";
import { queryClient } from "@/query-client";
import { settleReactWork } from "./settle-react-work";

/**
 * After the person answers an approval, the conversation shows the Bot working until it is done.
 *
 * Found on the Mac: a Bot looking something up in Google Maps stopped for Allow once, the person
 * allowed it, and the conversation then showed neither "Thinking" nor a Stop button while the Bot
 * went on working. The run that asked ended here on the interrupt, and the server runs the action
 * and carries the conversation on in a turn no browser streams, so nothing in this tab knew it was
 * going.
 *
 * The real provider, ChannelChat and the real AG-UI agent; only the HTTP boundary is synthetic. The
 * replay is the run as the server records it: a step that finished, the step it stopped on, then
 * RUN_FINISHED on the interrupt. The inbox is the server's own record of the request, which it marks
 * `completed` only once the turn it carried on has ended.
 */

const NativeResponse = globalThis.Response;
const channel: AgentChannel = {
  id: "maps-channel",
  name: "Coffee near the office",
  agentIds: ["maps-bot"],
  threadId: "maps-thread",
  active: true,
  lastMessageAt: "2026-11-08T09:00:00.000Z",
};
const ask = {
  id: "ask",
  role: "user",
  content: "Find a coffee shop near the office.",
} satisfies Message;
const geocode = {
  id: "geocoded",
  role: "assistant",
  content: "",
  toolCalls: [
    {
      id: "call-geocode",
      type: "function",
      function: {
        name: "mcp__google-maps__maps_geocode",
        arguments: '{"address":"1 Market St"}',
      },
    },
  ],
} satisfies Message;
const geocoded = {
  id: "geocode-result",
  role: "tool",
  toolCallId: "call-geocode",
  content: '{"lat":37.79,"lng":-122.39}',
} satisfies Message;
const search = {
  id: "searching",
  role: "assistant",
  content: "",
  toolCalls: [
    {
      id: "call-search",
      type: "function",
      function: {
        name: "mcp__google-maps__maps_search_places",
        arguments: '{"query":"coffee"}',
      },
    },
  ],
} satisfies Message;

/** The approval for the search, as the server holds it, at whatever status it has reached. */
let status: "pending" | "approved" | "consumed" | "completed";
/** When the person decided it, as the server stamps it; null while it waits. */
let decidedAt: string | null;
let decisions: string[] = [];
/** The thread's history as the platform's read returns it now. */
let stored: Message[];
/** How many times the conversation has read it. */
let historyReads = 0;
const searched = {
  id: "search-result",
  role: "tool",
  toolCallId: "call-search",
  content: '[{"name":"Blue Bottle","rating":4.6}]',
} satisfies Message;
const WHOLE =
  "Blue Bottle on Market St is the closest, a four minute walk, and it is open until six today.";
/** The reply the server's turn wrote, as much of it as the platform's read holds. */
const said = (content: string) =>
  ({ id: "reply-maps", role: "assistant", content }) satisfies Message;
let originalFetch: typeof fetch;

/** Requests the server's turn opened after the first, as the inbox lists them. */
let later: ApprovalInboxData["requests"] = [];

function inbox(): ApprovalInboxData {
  return {
    enabled: true,
    requests: [
      ...later,
      {
        id: "approval-1",
        status,
        createdAt: "2026-11-08T09:00:00.000Z",
        decidedAt,
        action: {
          botId: "maps-bot",
          toolRef: "google-maps/maps_search_places",
          effect: "read",
          scope: "google-maps",
          threadId: channel.threadId,
          toolCallId: "call-search",
          args: { query: "coffee" },
          target: {},
          policy: {
            behaviour: "ask",
            source: "rule",
            reason: "You asked to be asked first.",
          },
        },
      },
    ],
    rules: [],
    teamRules: [],
    questions: [],
  };
}

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/" });
  originalFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = new URL(
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url,
        "http://localhost",
      );
      const method = (
        input instanceof Request ? input.method : (init?.method ?? "GET")
      ).toUpperCase();
      if (url.pathname === "/api/approvals")
        return NativeResponse.json(inbox());
      if (url.pathname === "/api/approvals/approval-1/decision") {
        const request =
          input instanceof Request ? input : new Request(url, init);
        const { decision } = (await request.json()) as { decision: string };
        decisions.push(decision);
        // As the server does: decided, and handed to the loop that carries the conversation on.
        status = "approved";
        decidedAt = new Date().toISOString();
        return NativeResponse.json({ id: "approval-1", status });
      }
      if (url.pathname === "/api/agents")
        return NativeResponse.json({ agents: [] });
      if (url.pathname === "/api/plugins/for/maps-bot")
        return NativeResponse.json({ skills: [], tools: [] });
      if (url.pathname === "/api/agents/maps-bot")
        return NativeResponse.json({
          agent: { id: "maps-bot", visibility: "public", canManage: true },
        });
      if (url.pathname === "/api/components/for-agent/maps-bot")
        return NativeResponse.json({ components: [] });
      if (url.pathname === "/api/admin/enterprise/me")
        return NativeResponse.json({ capabilities: {}, enforced: false });
      if (url.pathname.endsWith("/info"))
        return NativeResponse.json({
          version: "fixture",
          agents: { "maps-bot": { description: "Fixture", capabilities: {} } },
          /*
           * Intelligence mode, as a deployment runs. Nothing answers on the socket, so the
           * conversation is restored from its history.
           */
          mode: "intelligence",
          intelligence: { wsUrl: "ws://127.0.0.1:9/client" },
          telemetryDisabled: true,
        });
      /*
       * Intelligence's connect: nothing running on the thread, so no join. The conversation is
       * drawn from its history, which ends on the step the run stopped on to ask.
       */
      if (url.pathname.endsWith("/connect"))
        return new NativeResponse(null, { status: 204 });
      if (/\/api\/channels\/[^/]+\/(activity|busy)$/.test(url.pathname))
        return new NativeResponse(null, { status: 204 });
      if (url.pathname === "/api/voice/sessions")
        return NativeResponse.json({ sessions: [], nextCursor: null });
      if (/\/threads\/[^/]+\/messages$/.test(url.pathname)) {
        historyReads += 1;
        return NativeResponse.json({ messages: stored });
      }
      throw new Error(`Unexpected fixture request: ${method} ${url.pathname}`);
    },
    {
      preconnect() {
        throw new Error("Unexpected fixture preconnect");
      },
    },
  );
});
afterEach(() => {
  cleanup();
  queryClient.clear();
});
afterAll(async () => {
  await settleReactWork();
  globalThis.fetch = originalFetch;
  GlobalRegistrator.unregister();
});

function mounting() {
  status = "pending";
  decidedAt = null;
  later = [];
  stored = [ask, geocode, geocoded, search];
  decisions = [];
  queryClient.setQueryData(channelKeys.list(), {
    pages: [
      {
        channels: [
          {
            ...channel,
            summary: null,
            lastMessage: "Waiting for your approval.",
            lastMessageAgentId: "maps-bot",
            createdAt: "2026-11-08T08:59:00.000Z",
            pinned: false,
            lastReadAt: null,
          },
        ],
        nextCursor: null,
      },
    ],
    pageParams: [""],
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <CopilotKitProvider runtimeUrl="http://localhost/api/copilotkit">
        <ChannelChat channel={channel} runtimeAgentId="maps-bot" />
      </CopilotKitProvider>
    </QueryClientProvider>,
  );
}

const STOP = '[data-testid="composer-stop"]';
const WORKING = ".tool-line-running";

test("after Allow once, the conversation shows the Bot working until the server's turn ends", async () => {
  const view = mounting();
  const user = userEvent.setup({ document: view.container.ownerDocument });

  // Waiting on the person: nothing is running, so nothing says it is.
  const allow = await view.findByRole("button", { name: "Allow once" });
  expect(view.container.querySelector(WORKING)).toBeNull();

  await user.click(allow);
  expect(decisions).toEqual(["allow_once"]);

  // The server has the turn: the step it is running shimmers.
  await waitFor(() =>
    expect(view.container.querySelector(WORKING)).not.toBeNull(),
  );

  // Still going once the action has started.
  status = "consumed";
  await act(() => queryClient.invalidateQueries({ queryKey: ["approvals"] }));
  expect(view.container.querySelector(WORKING)).not.toBeNull();
  /*
   * No Stop: this tab has no run of its own to stop, and the server's turn cannot be reached from
   * here yet. A Stop that does nothing is worse than none.
   */
  expect(view.container.querySelector(STOP)).toBeNull();

  // The server's turn ends: nothing says the Bot is working any more.
  status = "completed";
  await act(() => queryClient.invalidateQueries({ queryKey: ["approvals"] }));
  await waitFor(() => expect(view.container.querySelector(WORKING)).toBeNull());
});

/*
 * A request the resume loop is still retrying, or gave up on without finishing, is not a turn the
 * conversation is in. Counted for good, it would leave "Thinking" up, and park every message
 * behind them, for as long as the row stayed that way.
 */
test("a decision older than the server's longest carried-on turn no longer counts as working", () => {
  const now = Date.parse("2026-11-08T10:00:00.000Z");
  const decided = (minutesAgo: number) => {
    status = "approved";
    decidedAt = new Date(now - minutesAgo * 60_000).toISOString();
    return inbox() as Parameters<typeof carryingOnAfterApproval>[0];
  };
  expect(carryingOnAfterApproval(decided(1), channel.threadId, now)).toBe(true);
  expect(carryingOnAfterApproval(decided(9), channel.threadId, now)).toBe(true);
  expect(carryingOnAfterApproval(decided(11), channel.threadId, now)).toBe(
    false,
  );
  // Another conversation's decision is not this one's turn.
  expect(carryingOnAfterApproval(decided(1), "another-thread", now)).toBe(
    false,
  );
});

/** Decide, and let the server finish its turn, with `history` what a read of the thread returns. */
async function carriedOnThenEnded(
  view: ReturnType<typeof mounting>,
  history: Message[],
) {
  const user = userEvent.setup({ document: view.container.ownerDocument });
  const allow = await view.findByRole("button", { name: "Allow once" });
  /*
   * The reads opening the conversation makes are over (its restore, and the refresh that tries again
   * for two and a quarter seconds), so nothing but the end of the server's turn reads the thread again.
   */
  let reads = -1;
  while (reads !== historyReads) {
    reads = historyReads;
    await act(() => Bun.sleep(2_000));
  }
  await user.click(allow);
  await waitFor(() =>
    expect(view.container.querySelector(WORKING)).not.toBeNull(),
  );
  stored = history;
  status = "completed";
  await act(() => queryClient.invalidateQueries({ queryKey: ["approvals"] }));
  await waitFor(() => expect(view.container.querySelector(WORKING)).toBeNull());
}

/*
 * A turn the person stopped has no reply for the roster to announce, and the roster is what told
 * the conversation to read its history again. So what the turn did say only appeared on reopening.
 */
test("when the server's turn ends, the conversation shows what it wrote without being opened again", async () => {
  const view = mounting();
  await carriedOnThenEnded(view, [
    ask,
    geocode,
    geocoded,
    search,
    searched,
    said(WHOLE),
  ]);
  expect(await view.findByText(WHOLE)).toBeTruthy();
}, 20_000);

/*
 * Found on the Mac: a reply read while the platform was still catching up read "...shared with" until
 * the conversation was opened again, because a message the conversation already holds was never read
 * twice. A later read now lengthens it.
 */
test("a reply first read half written is shown whole once a later read holds all of it", async () => {
  const view = mounting();
  const half = WHOLE.slice(0, WHOLE.indexOf("walk") + 4);
  await carriedOnThenEnded(view, [
    ask,
    geocode,
    geocoded,
    search,
    searched,
    said(half),
  ]);
  expect(await view.findByText(half)).toBeTruthy();

  // The platform catches up, and the roster says the Bot replied.
  stored = [ask, geocode, geocoded, search, searched, said(WHOLE)];
  act(() => {
    queryClient.setQueryData(channelKeys.list(), {
      pages: [
        {
          channels: [
            {
              ...channel,
              summary: null,
              lastMessage: WHOLE,
              lastMessageAgentId: "maps-bot",
              lastMessageAt: "2026-11-08T09:01:00.000Z",
              createdAt: "2026-11-08T08:59:00.000Z",
              pinned: false,
              lastReadAt: null,
            },
          ],
          nextCursor: null,
        },
      ],
      pageParams: [""],
    });
  });
  expect(await view.findByText(WHOLE)).toBeTruthy();
  expect(view.queryByText(half)).toBeNull();
}, 20_000);

/*
 * Found on the Mac: the turn the server carried on reached a second action that needed the person,
 * opened its request, and the conversation never showed it. The server now ends that turn there and
 * finishes the first decision; the conversation then reads its history, which ends on the new step,
 * and draws its card.
 */
test("a second approval the server's turn stops on is asked in the conversation", async () => {
  const view = mounting();
  const directions = {
    id: "asking-directions",
    role: "assistant",
    content: "",
    toolCalls: [
      {
        id: "call-directions",
        type: "function",
        function: {
          name: "mcp__google-maps__maps_directions",
          arguments: '{"destination":"Blue Bottle"}',
        },
      },
    ],
  } satisfies Message;
  const [first] = inbox().requests;
  if (!first) throw new Error("No first request.");
  later = [
    {
      ...first,
      id: "approval-2",
      status: "pending",
      decidedAt: null,
      action: {
        ...first.action,
        toolRef: "google-maps/maps_directions",
        toolCallId: "call-directions",
        args: { destination: "Blue Bottle" },
      },
    },
  ];
  await carriedOnThenEnded(view, [
    ask,
    geocode,
    geocoded,
    search,
    searched,
    directions,
  ]);

  // Asked again, in the conversation, and nothing says the Bot is still going.
  expect(
    await view.findByRole("region", { name: "Waiting for your approval" }),
  ).toBeTruthy();
  expect(view.getByRole("button", { name: "Allow once" })).toBeTruthy();
  expect(view.container.querySelector(WORKING)).toBeNull();
}, 20_000);
