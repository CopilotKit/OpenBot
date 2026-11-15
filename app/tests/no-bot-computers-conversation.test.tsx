import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
import type { Message } from "@ag-ui/core";
import { CopilotKitProvider } from "@copilotkit/react-core/v2";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { type InfiniteData, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render } from "@testing-library/react";
import { ChannelChat } from "@/components/channels/channel-chat";
import {
  type AgentChannel,
  type ChannelPage,
  type ChannelSummary,
  channelKeys,
} from "@/lib/channels/queries";
import { ActiveBotProvider } from "@/lib/copilot/active-bot";
import { ComputerTools } from "@/lib/copilot/computer-tools";
import { queryClient } from "@/query-client";
import {
  DEPLOYMENT_PATH,
  deploymentResponse,
  MY_CAPABILITIES_PATH,
} from "./admin-settings-api";
import { botGrantsPath, botGrantsResponse } from "./bot-grants-api";
import { answerBotsList, botPath } from "./bots-api";
import { botComponentsPath, botComponentsResponse } from "./components-api";
import { settleReactWork } from "./settle-react-work";

/**
 * An open conversation on an OpenBot with no computers for Bots asks nothing about the Bot's
 * computer.
 *
 * A conversation looks once a second for a browser task its Bot left waiting on the person, by
 * reading who has control of the Bot's computer. Where there are no computers the server refuses
 * that read, so a person who only had a conversation open sent a refused request every second.
 *
 * The real conversation and the real computer tools, with the app's own query client, against a
 * runtime and a server that answer as the real ones do and keep every request.
 */

const BOT = "quiet-bot";
const COMPUTER = `/api/v2/organizations/default/computers/${BOT}`;
const SINCE = "2026-11-14T00:00:00.000Z";
const channel: AgentChannel = {
  id: "quiet-channel",
  name: "Quiet",
  agentIds: [BOT],
  threadId: "quiet-thread",
  active: true,
  lastMessageAt: SINCE,
};
const NativeResponse = globalThis.Response;
const stored: Message[] = [];

/** Whether this OpenBot has computers for Bots, as its deployment says. */
let botComputers = true;
let asked: string[] = [];
let originalFetch: typeof fetch;
let originalSocket: typeof WebSocket;

class QuietSocket {
  static readonly OPEN = 1;
  readyState = 0;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  send() {}
  close() {}
}

function sse(events: unknown[]) {
  return new NativeResponse(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
}

beforeAll(() => {
  GlobalRegistrator.register();
  originalFetch = globalThis.fetch;
  originalSocket = globalThis.WebSocket;
  globalThis.WebSocket = QuietSocket as unknown as typeof WebSocket;
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
      asked.push(`${init?.method ?? "GET"} ${url.pathname}`);
      if (url.pathname === DEPLOYMENT_PATH)
        return deploymentResponse({ botComputers });
      if (url.pathname.startsWith(COMPUTER)) {
        // Every call about a computer is refused where there are none.
        if (!botComputers)
          return NativeResponse.json(
            {
              type: "about:blank",
              title: "Service Unavailable",
              status: 503,
              code: "SERVICE_UNAVAILABLE",
              detail: "This OpenBot has no computers for Bots.",
            },
            {
              status: 503,
              headers: { "content-type": "application/problem+json" },
            },
          );
        if (url.pathname === `${COMPUTER}/control`)
          return NativeResponse.json({
            holder: "bot",
            since: SINCE,
            requested: false,
            transitioning: false,
            resumeSnapshotRequired: false,
            recoveryRequired: false,
          });
        if (url.pathname === COMPUTER)
          return NativeResponse.json({ botId: BOT, state: "absent" });
        return NativeResponse.json({ error: "Not found" }, { status: 404 });
      }
      if (url.pathname.endsWith("/info"))
        return NativeResponse.json({
          version: "fixture",
          agents: { [BOT]: { description: "Fixture", capabilities: {} } },
          mode: "sse",
          telemetryDisabled: true,
        });
      if (url.pathname.endsWith("/connect"))
        return sse([
          { type: "RUN_STARTED", threadId: channel.threadId, runId: "join" },
          { type: "MESSAGES_SNAPSHOT", messages: stored },
          { type: "RUN_FINISHED", threadId: channel.threadId, runId: "join" },
        ]);
      if (url.pathname.match(/\/threads\/[^/]+\/messages$/))
        return NativeResponse.json({ messages: stored });
      const bots = answerBotsList(url, init, { visible: [] });
      if (bots) return bots;
      if (url.pathname === botPath(BOT))
        return NativeResponse.json({
          bot: { id: BOT, visibility: "public", canManage: true },
        });
      if (url.pathname === botComponentsPath(BOT))
        return botComponentsResponse();
      if (url.pathname === MY_CAPABILITIES_PATH)
        return NativeResponse.json({ capabilities: {}, enforced: false });
      if (url.pathname === botGrantsPath(BOT)) return botGrantsResponse();
      if (
        /^\/api\/v2\/organizations\/default\/conversations\/[^/]+\/voice-sessions$/.test(
          url.pathname,
        )
      )
        return NativeResponse.json({ sessions: [], nextCursor: null });
      if (
        /^\/api\/v2\/organizations\/default\/conversations\/[^/]+\/(activity|signal-busy)$/.test(
          url.pathname,
        )
      )
        return new NativeResponse(null, { status: 204 });
      if (
        /^\/api\/v2\/organizations\/default\/people\/me\/approval-modes\/[^/]+$/.test(
          url.pathname,
        )
      )
        return NativeResponse.json({ asksEveryStep: false });
      return NativeResponse.json({ error: "Not found" }, { status: 404 });
    },
    { preconnect: () => undefined },
  );
});

beforeEach(() => {
  asked = [];
  sessionStorage.clear();
  queryClient.clear();
  queryClient.setQueryData<InfiniteData<ChannelPage>>(channelKeys.list(), {
    pages: [
      {
        channels: [
          {
            ...channel,
            summary: null,
            lastMessage: null,
            lastMessageAgentId: null,
            createdAt: SINCE,
            pinned: false,
            lastReadAt: null,
          } satisfies ChannelSummary,
        ],
        nextCursor: null,
      },
    ],
    pageParams: [""],
  });
});
afterEach(() => cleanup());
afterAll(async () => {
  await settleReactWork();
  // The app's own query client outlives this file: leave nothing in it to refetch in the next.
  queryClient.clear();
  globalThis.fetch = originalFetch;
  globalThis.WebSocket = originalSocket;
  GlobalRegistrator.unregister();
});

/** The conversation, open and idle, for long enough for two of its once-a-second reads. */
async function openConversation() {
  const view = render(
    <QueryClientProvider client={queryClient}>
      <CopilotKitProvider runtimeUrl="http://localhost/api/copilotkit">
        <ActiveBotProvider>
          <ComputerTools />
          <ChannelChat channel={channel} runtimeAgentId={BOT} />
        </ActiveBotProvider>
      </CopilotKitProvider>
    </QueryClientProvider>,
  );
  await view.findByRole("textbox", { name: "Message" });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 2500));
  });
  return view;
}

const aboutComputers = () =>
  asked.filter((request) => request.includes("/computers"));

test("an open conversation asks nothing about the Bot's computer where there are no computers for Bots", async () => {
  botComputers = false;
  await openConversation();

  expect(asked).toContain(`GET ${DEPLOYMENT_PATH}`);
  expect(aboutComputers()).toEqual([]);
}, 15_000);

test("where there are computers, an open conversation reads who has control every second, as before", async () => {
  botComputers = true;
  await openConversation();

  const reads = aboutComputers().filter(
    (request) => request === `GET ${COMPUTER}/control`,
  );
  expect(reads.length).toBeGreaterThanOrEqual(2);
}, 15_000);
