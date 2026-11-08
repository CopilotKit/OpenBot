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
import { settleReactWork } from "./settle-react-work";

/**
 * A SKILL ON THE FIRST MESSAGE OF A NEW CONVERSATION, FROM THE `/` CHIP TO THE RUN THAT LEAVES THE
 * BROWSER.
 *
 * A picked skill leaves the browser as `/<command>` at the start of the person's words, and the
 * server gives the Bot that skill's stored instructions (server/src/plugins/picked-skill.ts). The
 * browser used to send the instructions as a system row of its own, which no Bot read as
 * instructions, and `/channel/new` once dropped even that for the first message of a new
 * conversation. The first message has to leave exactly as a later one does: command first, and no
 * row of the browser's own carrying the skill.
 *
 * Everything below the HTTP boundary is real: the `/channel/new` route and its composer, the start
 * sequence, the hand-over to the channel screen, `ChannelChat`, its agent and the run request. Only
 * `fetch` is a fixture. The channel screen route is reduced to `ChannelChat` itself, which is the
 * part of it that sends; the rest of that page is chrome around it.
 */

const NativeResponse = globalThis.Response;
const BOT = "tally-bot";
const INSTRUCTION =
  "Reply as a tally card. The first line must be exactly TALLY CARD KITTIWAKE-9.";

const bot: AgentProfile = {
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
  name: "Tally Bot",
  roleDescription: "Counts things.",
  systemOwned: false,
  title: "Clerk",
  visibility: "private",
  id: BOT,
};

const channel: AgentChannel = {
  id: "new-skill-channel",
  name: "Tally Bot",
  agentIds: [BOT],
  threadId: "new-skill-thread",
  active: true,
  lastMessageAt: "2026-11-05T00:00:00.000Z",
};

/** The run inputs that actually left the browser, in order. */
let runs: RunAgentInput[] = [];
let originalFetch: typeof fetch;

function sse(events: unknown[]) {
  return new NativeResponse(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
}

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/" });
  /*
   * The `/` menu opens at the caret: prompt-area measures the caret's range and draws no menu for
   * a range with no box. happy-dom lays nothing out, so every range measures empty; a browser's
   * caret is a line tall. This is that line, and nothing else about layout is assumed.
   */
  const caret = { x: 8, y: 8, top: 8, left: 8, width: 1, height: 16 };
  Range.prototype.getBoundingClientRect = () =>
    ({ ...caret, right: 9, bottom: 24, toJSON: () => caret }) as DOMRect;
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
      if (url.pathname === "/api/channels" && method === "POST")
        return NativeResponse.json({ channel }, { status: 201 });
      if (url.pathname === "/api/route")
        return NativeResponse.json({ agentId: BOT, reason: "chosen" });
      if (url.pathname === "/api/agents")
        return NativeResponse.json({ agents: [bot] });
      if (url.pathname === `/api/agents/${BOT}`)
        return NativeResponse.json({ agent: bot });
      if (url.pathname === `/api/plugins/for/${BOT}`)
        return NativeResponse.json({
          tools: [],
          skills: [
            {
              slug: "tally",
              title: "Barrel tally",
              summary: "Barrel tally",
              instructions: INSTRUCTION,
            },
          ],
        });
      if (url.pathname === `/api/components/for-agent/${BOT}`)
        return NativeResponse.json({ components: [] });
      if (url.pathname === "/api/voice/sessions")
        return NativeResponse.json({ sessions: [], nextCursor: null });
      if (url.pathname === "/api/admin/enterprise/me")
        return NativeResponse.json({ capabilities: {}, enforced: false });
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
          { type: "MESSAGES_SNAPSHOT", messages: [] },
          { type: "RUN_FINISHED", threadId: channel.threadId, runId: "join" },
        ]);
      if (url.pathname.endsWith("/run")) {
        const request =
          input instanceof Request ? input : new Request(url, init);
        const body = RunAgentInputSchema.parse(await request.json());
        runs.push(body);
        return sse([
          { type: "RUN_STARTED", threadId: body.threadId, runId: body.runId },
          { type: "RUN_FINISHED", threadId: body.threadId, runId: body.runId },
        ]);
      }
      if (/\/api\/channels\/[^/]+(\/(activity|busy|read))?$/.test(url.pathname))
        return method === "GET"
          ? NativeResponse.json({ channel })
          : new NativeResponse(null, { status: 204 });
      if (/\/threads\/[^/]+(\/messages)?$/.test(url.pathname))
        return NativeResponse.json({ messages: [] });
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

test("the first message of a new conversation carries its skill, as the next one would", async () => {
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
  await user.keyboard("/tally");
  await user.click(await view.findByRole("option", { name: /tally/ }));
  await user.keyboard(" Count the north store room.");
  await user.keyboard("{Enter}");

  await waitFor(() => expect(runs.length).toBeGreaterThan(0), {
    timeout: 5000,
  });
  const messages = runs[0]?.messages ?? [];
  const asked = messages.findIndex(
    (message) =>
      message.role === "user" &&
      textOf(message).includes("Count the north store room."),
  );
  expect(asked).toBeGreaterThanOrEqual(0);
  // The command at the start of the words, where the server finds the skill.
  expect(textOf(messages[asked] as Message)).toStartWith("/tally ");
  // And the instructions nowhere in what the browser sent: only the server's stored copy counts.
  for (const message of messages)
    expect(textOf(message)).not.toContain(INSTRUCTION);
});
