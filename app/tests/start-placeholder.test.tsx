import "./home-fallback-routing.fixture";

import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
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
import { BotLookProvider } from "@/components/agents/bot-look";
import { type AgentProfile, agentKeys } from "@/lib/agents/queries";
import {
  beginPendingStart,
  endPendingStart,
  settlePendingStart,
} from "@/lib/channels/pending-start";
import { deploymentKeys } from "@/lib/deployment/queries";
import { Route as HomeRoute } from "@/routes/_authed/_app/index";
import { Route as StartRoute } from "@/routes/_authed/_app/start.$startId";
import { settleReactWork } from "./settle-react-work";

/**
 * THE PLACEHOLDER A MESSAGE FROM HOME OPENS, BEFORE ITS CONVERSATION EXISTS.
 *
 * It stands in for the conversation, so it has to be drawn the way the conversation is drawn, or
 * the message jumps when the real one replaces it. And it is a page in the history like any other:
 * somebody who leaves it and comes back after the conversation was made is coming back to that
 * conversation. Everything here is the real route component; only `fetch` is a fixture.
 */

const originalFetch = globalThis.fetch;

const knowledge: AgentProfile = {
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
  name: "Knowledge",
  roleDescription: "Answers company questions.",
  systemOwned: false,
  title: "Company Knowledge",
  visibility: "public",
  id: "knowledge",
};

/** What `fetch` answers in this file; a test that sends something replaces it. */
let answer: (url: string, init?: RequestInit) => Promise<Response> = (url) => {
  throw new Error(`Unexpected fetch: ${url}`);
};

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/" });
  globalThis.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) =>
      answer(typeof input === "string" ? input : input.toString(), init),
    { preconnect: originalFetch.preconnect },
  );
});

afterEach(() => {
  cleanup();
  for (const id of ["named", "settled", "reloaded"]) endPendingStart(id);
  answer = (url) => {
    throw new Error(`Unexpected fetch: ${url}`);
  };
});

afterAll(async () => {
  await settleReactWork();
  globalThis.fetch = originalFetch;
  GlobalRegistrator.unregister();
});

function renderAt(path: string, { home = false } = {}) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
    },
  });
  // What the home page that sent the message had already loaded.
  queryClient.setQueryData(agentKeys.list(false), [knowledge]);
  queryClient.setQueryData(deploymentKeys.capabilities(), {
    edition: "team",
  });

  const rootRoute = createRootRoute({ component: Outlet });
  type TestFileRouteWiring = Parameters<typeof StartRoute.update>[0] & {
    id: string;
    path: string;
    getParentRoute: () => typeof rootRoute;
  };
  const routeTree = rootRoute.addChildren([
    createRoute({
      getParentRoute: () => rootRoute,
      path: "/",
      component: home ? HomeRoute.options.component : () => <p>Home</p>,
    }),
    StartRoute.update({
      id: "/start/$startId",
      path: "/start/$startId",
      getParentRoute: () => rootRoute,
    } as TestFileRouteWiring),
    createRoute({
      getParentRoute: () => rootRoute,
      path: "/channel/$channelId",
      component: () => <p>The conversation</p>,
    }),
  ]);
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <BotLookProvider value="orb">
        <RouterProvider router={router} />
      </BotLookProvider>
    </QueryClientProvider>,
  );
  return Object.assign(view, { router });
}

test("the placeholder for a Bot named with @ is that conversation's own screen, Bot and all", async () => {
  beginPendingStart("named", {
    text: "Summarize our onboarding policy",
    agentId: "knowledge",
  });

  const view = renderAt("/start/named");

  // The Bot's intro above the message, as the conversation opens with it, from the roster at once.
  expect(
    (await view.findByRole("heading", { level: 1, name: "Knowledge" }))
      .textContent,
  ).toBe("Knowledge");
  // The message in the conversation's own transcript, not a copy of it drawn beside one.
  await waitFor(() =>
    expect(
      view.container
        .querySelector('[data-slot="message-scroller-viewport"]')
        ?.textContent?.includes("Summarize our onboarding policy"),
    ).toBe(true),
  );
  expect(
    view.container.querySelector('[data-slot="conversation-header"]')
      ?.textContent,
  ).toBe("Knowledge");
});

test("coming back to a placeholder whose conversation now exists opens the conversation", async () => {
  // The start finished while the person was elsewhere, and forgot itself, as it does.
  beginPendingStart("settled", { text: "hello", agentId: null });
  settlePendingStart("settled", "channel-9");
  endPendingStart("settled");

  const view = renderAt("/start/settled");

  expect(await view.findByText("The conversation")).toBeTruthy();
  expect(view.router.state.location.pathname).toBe("/channel/channel-9");
});

test("a placeholder nothing is being started under, after a reload, goes home", async () => {
  const view = renderAt("/start/reloaded");

  expect(await view.findByText("Home")).toBeTruthy();
  expect(view.router.state.location.pathname).toBe("/");
});

test("sent from home, left before it was made, and come back to: the conversation opens", async () => {
  let picked: (response: Response) => void = () => undefined;
  const made: string[] = [];
  answer = async (url, init) => {
    if (url === "/api/route")
      return new Promise<Response>((resolve) => {
        picked = resolve;
      });
    if (url === "/api/channels" && init?.method === "POST") {
      made.push(String(init.body));
      return Response.json({
        channel: {
          id: "channel-made",
          name: "Knowledge",
          agentIds: ["knowledge"],
          threadId: "thread-made",
          active: true,
          lastMessageAt: null,
        },
      });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };
  const view = renderAt("/", { home: true });
  const user = userEvent.setup({ document: view.container.ownerDocument });
  await user.type(
    await view.findByRole("textbox", { name: "Message" }),
    "What were our Q3 numbers?",
  );
  await user.click(await view.findByRole("button", { name: "Send message" }));
  await waitFor(() =>
    expect(view.router.state.location.pathname).toStartWith("/start/"),
  );

  // Off to home's own link while the Bot is being picked; the conversation is made behind it.
  await view.router.navigate({ to: "/" });
  picked(Response.json({ agentId: "knowledge", reason: "matched" }));
  await waitFor(() => expect(made).toHaveLength(1));
  // Not pulled back to it.
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(view.router.state.location.pathname).toBe("/");

  view.router.history.back();

  expect(await view.findByText("The conversation")).toBeTruthy();
  expect(view.router.state.location.pathname).toBe("/channel/channel-made");
});
