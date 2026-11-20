/**
 * A conversation opened while the OpenBot it is connected to can't be reached shows its messages
 * once that OpenBot answers again, with nobody clicking away and back.
 *
 * Inside OpenBot Desktop connected to an OpenBot somewhere else, the desktop app's relay answers
 * the page itself when that OpenBot does not: a 502, text/plain, "OpenBot could not be reached."
 * (desktop/src-tauri/src/connected/relay.rs). Seen on a real Windows computer: the conversation kept
 * its failure after the line cleared, until the person opened another conversation and came back.
 *
 * This file plays OpenBot at the HTTP boundary, the runtime included (`/info`, `/connect`, the
 * thread's stored messages), as `channel-failed-run-restore.test.tsx` does. The desktop app stands in
 * at `window.__TAURI_INTERNALS__`. The provider, the conversation, the line and the client are real.
 */
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import type { Message } from "@ag-ui/core";
import { CopilotKitProvider } from "@copilotkit/react-core/v2";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { type InfiniteData, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { ChannelChat } from "@/components/channels/channel-chat";
import { ConnectionBanner } from "@/components/layout/connection-banner";
import {
  type AgentChannel,
  type ChannelPage,
  channelKeys,
} from "@/lib/channels/queries";
import { askWhetherOpenBotAnswers } from "@/lib/deployment/queries";
import { queryClient } from "@/query-client";
import { MY_CAPABILITIES_PATH } from "./admin-settings-api";
import { botGrantsPath, botGrantsResponse } from "./bot-grants-api";
import { answerBotsList, botPath } from "./bots-api";
import { botComponentsPath, botComponentsResponse } from "./components-api";

const NativeResponse = globalThis.Response;
const channel: AgentChannel = {
  id: "away-channel",
  name: "Away",
  agentIds: ["away-bot"],
  threadId: "away-thread",
  active: true,
  lastMessageAt: "2026-11-15T00:00:00.000Z",
};
const said: Message[] = [
  { id: "ask-1", role: "user", content: "What changed overnight?" },
  { id: "reply-1", role: "assistant", content: "Two pull requests merged." },
];

let openbot: "answers" | "unreachable" = "answers";
let originalFetch: typeof fetch;
/** Every runtime request that went out while OpenBot answered, by path. */
let runtime: string[] = [];

function relayUnreachable(): Response {
  return new NativeResponse("OpenBot could not be reached.", {
    status: 502,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

function answer(url: URL, init?: RequestInit): Response {
  const bots = answerBotsList(url, init, { visible: [] });
  if (bots) return bots;
  if (url.pathname === botGrantsPath("away-bot")) return botGrantsResponse();
  if (url.pathname === botPath("away-bot"))
    return NativeResponse.json({
      bot: { id: "away-bot", visibility: "public", canManage: true },
    });
  if (url.pathname === botComponentsPath("away-bot"))
    return botComponentsResponse();
  if (url.pathname === MY_CAPABILITIES_PATH)
    return NativeResponse.json({ capabilities: {}, enforced: false });
  if (url.pathname.endsWith("/deployment"))
    return NativeResponse.json({ edition: "team" });
  if (url.pathname.startsWith("/api/copilotkit")) runtime.push(url.pathname);
  if (url.pathname.endsWith("/info"))
    return NativeResponse.json({
      version: "fixture",
      agents: { "away-bot": { description: "Fixture", capabilities: {} } },
      mode: "sse",
      telemetryDisabled: true,
    });
  // Nothing running on the thread: the join replays nothing, and the store holds what was said.
  if (url.pathname.endsWith("/connect"))
    return new NativeResponse("", {
      headers: { "content-type": "text/event-stream" },
    });
  if (
    /^\/api\/v2\/organizations\/default\/conversations\/[^/]+\/(activity|signal-busy)$/.test(
      url.pathname,
    )
  )
    return new NativeResponse(null, { status: 204 });
  if (
    /^\/api\/v2\/organizations\/default\/conversations\/[^/]+\/voice-sessions$/.test(
      url.pathname,
    )
  )
    return NativeResponse.json({ sessions: [], nextCursor: null });
  if (/\/threads\/away-thread\/messages$/.test(url.pathname))
    return NativeResponse.json({ messages: said });
  return NativeResponse.json({});
}

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://127.0.0.1:53113/" });
  originalFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = new URL(
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url,
        "http://127.0.0.1:53113",
      );
      return openbot === "answers" ? answer(url, init) : relayUnreachable();
    },
    { preconnect: originalFetch.preconnect },
  );
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
    invoke: async (command: string) => {
      if (command === "plugin:openbot-desktop|connection")
        return { mode: "connected", address: "https://openbot.example.com" };
      throw `command ${command} not found`;
    },
    transformCallback: () => 0,
  };
});
afterEach(async () => {
  cleanup();
  openbot = "answers";
  // A plain request, not a read: reads wait while the connection is lost.
  await askWhetherOpenBotAnswers();
  queryClient.clear();
  runtime = [];
});
afterAll(() => {
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  globalThis.fetch = originalFetch;
  GlobalRegistrator.unregister();
});

function open() {
  queryClient.setQueryData<InfiniteData<ChannelPage>>(channelKeys.list(), {
    pages: [
      {
        channels: [
          {
            ...channel,
            summary: null,
            lastMessage: null,
            lastMessageAgentId: null,
            createdAt: "2026-11-15T00:00:00.000Z",
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
      <CopilotKitProvider runtimeUrl="/api/copilotkit">
        <ConnectionBanner />
        <ChannelChat
          channel={channel}
          key={channel.id}
          runtimeAgentId="away-bot"
        />
      </CopilotKitProvider>
    </QueryClientProvider>,
  );
}

/** The conversation opened while OpenBot can't be reached, once its join and its read have failed. */
async function openedWhileAway() {
  openbot = "unreachable";
  const view = open();
  await view.findByRole(
    "complementary",
    { name: "Connection" },
    { timeout: 5_000 },
  );
  await act(() => new Promise((resolve) => setTimeout(resolve, 2_000)));
  expect(view.queryByText("Two pull requests merged.")).toBeNull();
  return view;
}

test("while the line shows, the conversation does not say again that it couldn't load", async () => {
  const view = await openedWhileAway();
  expect(
    view.queryByText("Couldn't load earlier messages", { exact: false }),
  ).toBeNull();
}, 15_000);

test("a conversation opened while OpenBot can't be reached shows its messages when it answers, with no click", async () => {
  const view = await openedWhileAway();

  openbot = "answers";
  await waitFor(
    () =>
      expect(
        view.queryByRole("complementary", { name: "Connection" }),
      ).toBeNull(),
    { timeout: 8_000 },
  );
  expect(
    await view.findByText("Two pull requests merged.", {}, { timeout: 5_000 }),
  ).toBeTruthy();
  expect(view.getByText("What changed overnight?")).toBeTruthy();
  // And the conversation joined its thread again, through the runtime.
  await waitFor(() =>
    expect(runtime.some((path) => path.endsWith("/connect"))).toBe(true),
  );
}, 25_000);
