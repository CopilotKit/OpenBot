import "./home-fallback-routing.fixture";

import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
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
import { cleanup, render, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ChannelChat } from "@/components/channels/channel-chat";
import { Toaster, toast } from "@/components/ui/toast";
import { type AgentProfile, agentKeys } from "@/lib/agents/queries";
import { type AgentChannel, channelQueryOptions } from "@/lib/channels/queries";
import type { ConversationModel, ModelCatalogue } from "@/lib/models/queries";
import { queryClient } from "@/query-client";
import { Route as HomeRoute } from "@/routes/_authed/_app/index";
import { MY_CAPABILITIES_PATH } from "./admin-settings-api";
import { botGrantsPath, botGrantsResponse } from "./bot-grants-api";
import { answerBotsList, botPath } from "./bots-api";
import { botComponentsPath, botComponentsResponse } from "./components-api";
import {
  CONVERSATIONS_PATH,
  conversationOf,
  conversationPage,
  conversationPath,
  problem,
  ROUTE_PATH,
} from "./conversations-api";
import {
  catalogueBody,
  catalogueView,
  modelChoiceConversation,
} from "./models-api";
import { settleReactWork } from "./settle-react-work";

/**
 * A MODEL PICKED ON THE HOME COMPOSER, BEFORE OPENBOT HAS PICKED THE BOT.
 *
 * The home screen starts a conversation with whichever Bot the message is routed to, so the picker
 * there starts on the catalogue default and the pick is saved with the conversation that Bot answers
 * in, before the first message runs, as `/channel/new` saves it. A Bot that hands work to agents
 * takes no pick: nothing is saved, and the person is told where its model is set.
 *
 * Everything below the HTTP boundary is real: the home route, its composer and picker, routing, the
 * start sequence, the hand-over to `ChannelChat` and the run request. Only `fetch` is a fixture.
 */

const NativeResponse = globalThis.Response;
const BOT = "terra-bot";

const bot: AgentProfile = {
  assignedToMe: false,
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
  name: "Terra Bot",
  roleDescription: "Answers on OpenBot's model.",
  systemOwned: false,
  title: "Analyst",
  visibility: "public",
  id: BOT,
  runsOnOpenBotModel: true,
};

const channel: AgentChannel = {
  id: "home-model-channel",
  name: "Terra Bot",
  agentIds: [BOT],
  threadId: "home-model-thread",
  active: true,
  lastMessageAt: "2026-11-16T00:00:00.000Z",
};

const catalogue: ModelCatalogue = {
  provider: "openai",
  source: "openai",
  exposure: "all",
  default: "gpt-5.5",
  choosable: true,
  models: [
    {
      id: "gpt-6.1-terra",
      label: "GPT-6.1 Terra",
      vendor: "openai",
      efforts: ["low", "medium", "high", "xhigh"],
      defaultEffort: "medium",
    },
    {
      id: "gpt-5.5",
      label: "GPT-5.5",
      vendor: "openai",
      efforts: ["low", "medium", "high"],
      defaultEffort: "medium",
    },
  ],
};

/** Every routing, start, model and run request, in the order they left the browser. */
let trail: string[] = [];
let saved: ConversationModel = { model: null, effort: null };
/** How the Bot works: on OpenBot's model itself, or handing work to agents. */
let mode: "self" | "orchestrate" = "self";
let originalFetch: typeof fetch;

function sse(events: unknown[]) {
  return new NativeResponse(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
}

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/" });
  // prompt-area positions its menus at a caret with a non-empty box.
  Range.prototype.getBoundingClientRect = () => new DOMRect(8, 8, 1, 16);
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
      if (url.pathname === ROUTE_PATH) {
        trail.push("route");
        return NativeResponse.json({
          botId: BOT,
          name: bot.name,
          reason: "matched",
          fallback: false,
          viaMention: false,
        });
      }
      if (url.pathname === CONVERSATIONS_PATH && method === "POST") {
        trail.push("create");
        return NativeResponse.json(
          { conversation: conversationOf(channel) },
          { status: 201 },
        );
      }
      if (url.pathname === CONVERSATIONS_PATH)
        return NativeResponse.json(conversationPage([]));
      if (catalogueView(url) === "offered")
        return NativeResponse.json(catalogueBody(catalogue));
      if (modelChoiceConversation(url.pathname) === channel.id) {
        if (method === "PUT") {
          const pick = JSON.parse(String(init?.body)) as ConversationModel;
          trail.push(`save ${pick.model} ${pick.effort}`);
          saved = { model: pick.model, effort: pick.effort };
        }
        return NativeResponse.json(saved);
      }
      const bots = answerBotsList(url, init, { visible: [bot] });
      if (bots) return bots;
      if (url.pathname === botPath(BOT))
        return NativeResponse.json({ bot: bot });
      if (url.pathname === `${botPath(BOT)}/delegation`)
        return NativeResponse.json({
          botId: BOT,
          mode,
          model: null,
          effort: null,
          instructions: "",
          agents: [
            {
              id: "bag_openbot",
              name: "OpenBot",
              description: "OpenBot's own agent.",
              kind: "openbot",
              available: true,
            },
          ],
          canManage: true,
        });
      if (url.pathname === botGrantsPath(BOT)) return botGrantsResponse();
      if (url.pathname === botComponentsPath(BOT))
        return botComponentsResponse();
      if (
        /^\/api\/v2\/organizations\/default\/conversations\/[^/]+\/voice-sessions$/.test(
          url.pathname,
        )
      )
        return NativeResponse.json({ sessions: [], nextCursor: null });
      if (url.pathname === MY_CAPABILITIES_PATH)
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
        trail.push("run");
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
      if (/\/threads\/[^/]+(\/messages)?$/.test(url.pathname))
        return NativeResponse.json({ messages: [] });
      // The home page's own reads this test is not about (who is signed in, the edition, skills).
      if (method === "GET") return problem(404, "Not found.");
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
  toast.close("home-model-not-used");
  queryClient.clear();
  trail = [];
  saved = { model: null, effort: null };
  mode = "self";
});

afterAll(async () => {
  await settleReactWork();
  globalThis.fetch = originalFetch;
  GlobalRegistrator.unregister();
});

function renderHome() {
  queryClient.setQueryData(agentKeys.list(false), [bot]);
  const rootRoute = createRootRoute({ component: Outlet });
  /** The channel screen, as far as sending goes: the channel record and `ChannelChat` on it. */
  function ChannelScreen() {
    const { channelId } = channelRoute.useParams();
    const { data } = useQuery(channelQueryOptions(channelId));
    return data ? <ChannelChat channel={data} runtimeAgentId={BOT} /> : null;
  }
  const channelRoute = createRoute({
    path: "/channel/$channelId",
    getParentRoute: () => rootRoute,
    component: ChannelScreen,
  });
  const routeTree = rootRoute.addChildren([
    createRoute({
      getParentRoute: () => rootRoute,
      path: "/",
      validateSearch: HomeRoute.options.validateSearch,
      component: HomeRoute.options.component,
    }),
    createRoute({
      getParentRoute: () => rootRoute,
      path: "/start/$startId",
      component: () => <p>Starting</p>,
    }),
    channelRoute,
    createRoute({
      getParentRoute: () => rootRoute,
      path: "/bots/$agentId/agents",
      component: () => <h1>Agents</h1>,
    }),
  ]);
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <CopilotKitProvider runtimeUrl="http://localhost/api/copilotkit">
        <Toaster>
          <RouterProvider router={router} />
        </Toaster>
      </CopilotKitProvider>
    </QueryClientProvider>,
  );
  return Object.assign(view, { router });
}

/** Pick GPT-6.1 Terra at Extra high on the home composer, starting from the catalogue default. */
async function pickTerraExtraHigh(
  view: ReturnType<typeof renderHome>,
  user: ReturnType<typeof userEvent.setup>,
) {
  // The catalogue's default, at its own default effort, until the person picks.
  await user.click(
    await view.findByRole("combobox", {
      name: "Model: GPT-5.5, thinking: Medium",
    }),
  );
  await user.click(
    within(await view.findByRole("dialog")).getByRole("option", {
      name: "GPT-6.1 Terra",
    }),
  );
  await user.click(
    within(await view.findByRole("dialog")).getByRole("option", {
      name: "Extra high",
    }),
  );
  expect(
    await view.findByRole("combobox", {
      name: "Model: GPT-6.1 Terra, thinking: Extra high",
    }),
  ).toBeTruthy();
}

test("a model picked on the home composer is saved with the routed Bot's conversation before it runs", async () => {
  const view = renderHome();
  const user = userEvent.setup({ document });

  await pickTerraExtraHigh(view, user);
  // Nothing is saved while there is no conversation, nor a Bot.
  expect(trail).toEqual([]);

  await user.click(await view.findByRole("textbox", { name: "Message" }));
  await user.keyboard("Summarise the quarter.{Enter}");

  await waitFor(() => expect(trail).toContain("run"), { timeout: 5000 });
  expect(trail.slice(0, 4)).toEqual([
    "route",
    "create",
    "save gpt-6.1-terra xhigh",
    "run",
  ]);
  expect(saved).toEqual({ model: "gpt-6.1-terra", effort: "xhigh" });
});

test("a routed Bot that hands work to agents keeps its own model, and says where it is set", async () => {
  mode = "orchestrate";
  const view = renderHome();
  const user = userEvent.setup({ document });

  await pickTerraExtraHigh(view, user);
  await user.click(await view.findByRole("textbox", { name: "Message" }));
  await user.keyboard("Plan the launch.{Enter}");

  await waitFor(() => expect(trail).toContain("run"), { timeout: 5000 });
  expect(trail.slice(0, 3)).toEqual(["route", "create", "run"]);
  expect(saved).toEqual({ model: null, effort: null });

  expect(
    await view.findByText(
      "Terra Bot hands work to agents, so it uses the model set on its Agents page.",
    ),
  ).toBeTruthy();
  await user.click(await view.findByRole("button", { name: "Open Agents" }));
  await waitFor(() =>
    expect(view.router.state.location.pathname).toBe(`/bots/${BOT}/agents`),
  );
});
