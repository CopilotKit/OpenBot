import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import type { Message, RunAgentInput } from "@ag-ui/core";
import { RunAgentInputSchema } from "@ag-ui/core/schemas";
import { CopilotKitProvider } from "@copilotkit/react-core/v2";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClientProvider, useQuery } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ChannelChat } from "@/components/channels/channel-chat";
import { type AgentProfile, agentKeys } from "@/lib/agents/queries";
import { type AgentChannel, channelQueryOptions } from "@/lib/channels/queries";
import { queryClient } from "@/query-client";
import { Route as ChannelNewRoute } from "@/routes/_authed/_app/channel/new";
import { MY_CAPABILITIES_PATH } from "./admin-settings-api";
import { botGrantsPath, botGrantsResponse } from "./bot-grants-api";
import { answerBotsList, botPath } from "./bots-api";
import { botComponentsPath, botComponentsResponse } from "./components-api";
import {
  CONVERSATIONS_PATH,
  conversationOf,
  conversationPath,
  ROUTE_PATH,
} from "./conversations-api";
import { settleReactWork } from "./settle-react-work";

/**
 * THE FIRST MESSAGE OF A NEW CONVERSATION LEAVES THE BROWSER AS SOON AS IT SHOWS.
 *
 * Once the person sees their message in the conversation, they may lock the phone or close the tab
 * at once, and the Bot must still get it. It used to wait in the page while the new thread was
 * joined, its history read and its voice chats loaded, a second or two on a good connection and
 * longer on a slow one, though a thread just made has none of them. A page closed in that time lost
 * the message: the conversation was made, and opened later empty, with no run in its thread.
 *
 * Here those three reads never answer, as on a connection that has stalled. The run still has to
 * leave straight away. Everything below the HTTP boundary is real, as in
 * `new-conversation-skill.test.tsx`: the `/channel/new` route and its composer, the start sequence,
 * the hand-over to the channel screen, `ChannelChat`, its agent and the run request.
 */

const NativeResponse = globalThis.Response;
const BOT = "harbour-bot";
const QUESTION = "When is high water at the north quay?";

/** How soon after the message shows its run has to have left: far under what the reads take. */
const LEAVES_WITHIN_MS = 1000;

const bot: AgentProfile = {
  assignedToMe: false,
  runsOnOpenBotModel: false,
  keyFromOpenBot: false,
  avatarSeed: "seed",
  builtIn: true,
  canManage: true,
  endpoint: null,
  hasAuth: false,
  hasCallbackToken: false,
  isolated: false,
  isolationActive: false,
  isolationOffReason: null,
  hidden: false,
  pinned: false,
  mine: true,
  name: "Harbour Bot",
  roleDescription: "Knows the tides.",
  systemOwned: false,
  title: "Harbour master",
  visibility: "private",
  id: BOT,
};

const channel: AgentChannel = {
  id: "sends-at-once-channel",
  name: "Harbour Bot",
  agentIds: [BOT],
  threadId: "sends-at-once-thread",
  active: true,
  lastMessageAt: null,
};

/** The run inputs that left the browser, and when. */
let runs: { input: RunAgentInput; at: number }[] = [];
let originalFetch: typeof fetch;

function sse(events: unknown[]) {
  return new NativeResponse(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
}

/** A request that never answers, as on a stalled connection, until the page gives up on it. */
function stalled(signal: AbortSignal | null | undefined): Promise<Response> {
  return new Promise((_resolve, reject) => {
    signal?.addEventListener("abort", () =>
      reject(new DOMException("Aborted", "AbortError")),
    );
  });
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
      const method =
        init?.method ?? (input instanceof Request ? input.method : "GET");
      const signal =
        init?.signal ?? (input instanceof Request ? input.signal : null);
      if (url.pathname === CONVERSATIONS_PATH && method === "POST")
        return NativeResponse.json(
          { conversation: conversationOf(channel) },
          { status: 201 },
        );
      if (url.pathname === ROUTE_PATH)
        return NativeResponse.json({
          botId: BOT,
          name: bot.name,
          reason: "chosen",
          fallback: false,
          viaMention: false,
        });
      const bots = answerBotsList(url, init, { visible: [bot] });
      if (bots) return bots;
      if (url.pathname === botPath(BOT))
        return NativeResponse.json({ bot: bot });
      if (url.pathname === botGrantsPath(BOT))
        return botGrantsResponse({ tools: [], skills: [] });
      if (url.pathname === botComponentsPath(BOT))
        return botComponentsResponse();
      if (url.pathname === MY_CAPABILITIES_PATH)
        return NativeResponse.json({ capabilities: {}, enforced: false });
      if (url.pathname.endsWith("/info"))
        return NativeResponse.json({
          version: "fixture",
          agents: { [BOT]: { description: "Fixture", capabilities: {} } },
          mode: "sse",
          telemetryDisabled: true,
        });
      // The three reads a new thread has nothing for: its join, its history and its voice chats.
      if (
        url.pathname.endsWith("/connect") ||
        /\/threads\/[^/]+(\/messages)?$/.test(url.pathname) ||
        /^\/api\/v2\/organizations\/default\/conversations\/[^/]+\/voice-sessions$/.test(
          url.pathname,
        )
      )
        return stalled(signal);
      if (url.pathname.endsWith("/run")) {
        const at = Date.now();
        const request =
          input instanceof Request ? input : new Request(url, init);
        const body = RunAgentInputSchema.parse(await request.json());
        runs.push({ input: body, at });
        return sse([
          { type: "RUN_STARTED", threadId: body.threadId, runId: body.runId },
          { type: "RUN_FINISHED", threadId: body.threadId, runId: body.runId },
        ]);
      }
      if (url.pathname === conversationPath(channel.id) && method === "GET")
        return NativeResponse.json({ conversation: conversationOf(channel) });
      if (
        /^\/api\/v2\/organizations\/default\/conversations\/[^/]+\/(activity|signal-busy|mark-read)$/.test(
          url.pathname,
        ) &&
        method === "POST"
      )
        return new NativeResponse(null, { status: 204 });
      // Anything else this screen asks for has nothing to say here.
      return new NativeResponse(null, { status: 404 });
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
  runs = [];
});

afterAll(async () => {
  await settleReactWork();
  globalThis.fetch = originalFetch;
  GlobalRegistrator.unregister();
});

const rootRoute = createRootRoute({ component: Outlet });
const authedRoute = createRoute({
  id: "/_authed",
  getParentRoute: () => rootRoute,
  component: Outlet,
});
const appRoute = createRoute({
  id: "/_app",
  getParentRoute: () => authedRoute,
  component: Outlet,
});
type TestFileRouteWiring = Parameters<typeof ChannelNewRoute.update>[0] & {
  id: string;
  path: string;
  getParentRoute: () => typeof appRoute;
};
const testChannelNewRoute = ChannelNewRoute.update({
  id: "/channel/new",
  path: "/channel/new",
  getParentRoute: () => appRoute,
} as TestFileRouteWiring);

/** The channel screen, as far as sending goes: the channel record and `ChannelChat` on it. */
function ChannelScreen() {
  const { channelId } = channelRoute.useParams();
  const { data } = useQuery(channelQueryOptions(channelId));
  return data ? <ChannelChat channel={data} runtimeAgentId={BOT} /> : null;
}
const channelRoute = createRoute({
  path: "/channel/$channelId",
  getParentRoute: () => appRoute,
  component: ChannelScreen,
});
const routeTree = rootRoute.addChildren([
  authedRoute.addChildren([
    appRoute.addChildren([testChannelNewRoute, channelRoute]),
  ]),
]);

function textOf(message: Message): string {
  return typeof message.content === "string"
    ? message.content
    : JSON.stringify(message.content);
}

test("the first message of a new conversation leaves as soon as it shows, without waiting on the thread", async () => {
  queryClient.setQueryData(agentKeys.list(false), [bot]);
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({
      initialEntries: [`/channel/new?agent=${BOT}`],
    }),
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <CopilotKitProvider runtimeUrl="http://localhost/api/copilotkit">
        <RouterProvider router={router} />
      </CopilotKitProvider>
    </QueryClientProvider>,
  );

  const user = userEvent.setup({ document });
  const editor = await view.findByRole("textbox", { name: "Message" });
  await waitFor(() =>
    expect(editor.getAttribute("aria-disabled")).not.toBe("true"),
  );
  await user.click(editor);
  await user.keyboard(QUESTION);
  await user.keyboard("{Enter}");

  // The conversation opens with the message in it: the moment a person may put the phone away.
  await waitFor(
    () => expect(router.state.location.pathname).toBe(`/channel/${channel.id}`),
    { timeout: 5000 },
  );
  await view.findByText(QUESTION, { exact: true }, { timeout: 5000 });
  const shownAt = Date.now();

  await waitFor(() => expect(runs.length).toBeGreaterThan(0), {
    timeout: 8000,
  });
  const [run] = runs;
  expect(
    (run?.at ?? Number.POSITIVE_INFINITY) - shownAt,
    "ms from the message showing to its run leaving",
  ).toBeLessThan(LEAVES_WITHIN_MS);
  // The run carries the person's words, once.
  const asked = (run?.input.messages ?? []).filter(
    (message) => message.role === "user" && textOf(message) === QUESTION,
  );
  expect(asked).toHaveLength(1);
}, 20_000);
