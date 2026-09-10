import "./home-fallback-routing.fixture";

import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type AgentProfile, agentKeys } from "@/lib/agents/queries";
import { Route as HomeRoute } from "@/routes/_authed/_app/index";

beforeAll(() => GlobalRegistrator.register());

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
  cleanup();
});

afterAll(() => GlobalRegistrator.unregister());

function agent(
  overrides: Partial<AgentProfile> & { id: string },
): AgentProfile {
  return {
    avatarSeed: "seed",
    builtIn: false,
    canManage: true,
    endpoint: null,
    hasAuth: false,
    hasCallbackToken: false,
    hidden: false,
    mine: true,
    name: "Agent",
    roleDescription: "Role",
    systemOwned: false,
    title: "Title",
    visibility: "private",
    ...overrides,
  };
}

function queryClientWithAgents(agents: AgentProfile[]) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        staleTime: Number.POSITIVE_INFINITY,
      },
    },
  });
  queryClient.setQueryData(agentKeys.list(false), agents);
  return queryClient;
}

function renderHome(queryClient: QueryClient) {
  const rootRoute = createRootRoute({ component: HomeRoute.options.component });
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

async function submitHomeMessage(
  view: ReturnType<typeof renderHome>,
  text: string,
) {
  const user = userEvent.setup({ document: view.container.ownerDocument });
  await user.type(await view.findByRole("textbox", { name: "Message" }), text);
  await user.click(await view.findByRole("button", { name: "Send message" }));
}

function installHomeRoutingFetch(options: {
  routeResponse: Response;
  starts: string[][];
}) {
  global.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/route") return options.routeResponse.clone();
      if (url === "/api/channels") {
        const body = JSON.parse(String(init?.body)) as { agentIds: string[] };
        options.starts.push(body.agentIds);
        return Response.json({
          channel: {
            busy: false,
            id: `channel-${options.starts.length}`,
            lastMessage: null,
            lastMessageAt: null,
            participantIds: body.agentIds,
            pinned: false,
            threadId: `thread-${options.starts.length}`,
            title: null,
            unread: false,
          },
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    },
    { preconnect: originalFetch.preconnect },
  );
}

test("/ fallback routing matches the server default when route selection is unavailable", async () => {
  const ownPublic = agent({
    id: "own-public",
    mine: true,
    name: "Own Public",
    visibility: "public",
  });
  const sharedPublic = agent({
    id: "shared-public",
    mine: false,
    name: "Shared Public",
    visibility: "public",
  });
  const starts: string[][] = [];
  installHomeRoutingFetch({
    routeResponse: Response.json({ error: "router down" }, { status: 503 }),
    starts,
  });
  const view = renderHome(queryClientWithAgents([ownPublic, sharedPublic]));

  await submitHomeMessage(view, "hello");

  await waitFor(() => expect(starts).toEqual([["own-public"]]));
});

test("/ keeps a successful route decision ahead of the fallback", async () => {
  const ownPublic = agent({
    id: "own-public",
    mine: true,
    name: "Own Public",
    visibility: "public",
  });
  const sharedPublic = agent({
    id: "shared-public",
    mine: false,
    name: "Shared Public",
    visibility: "public",
  });
  const starts: string[][] = [];
  installHomeRoutingFetch({
    routeResponse: Response.json({
      agentId: "shared-public",
      fallback: false,
      name: "Shared Public",
      reason: "matched",
      viaMention: false,
    }),
    starts,
  });
  const view = renderHome(queryClientWithAgents([ownPublic, sharedPublic]));

  await submitHomeMessage(view, "hello");

  await waitFor(() => expect(starts).toEqual([["shared-public"]]));
});
