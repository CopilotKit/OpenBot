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
import { type AgentProfile, agentKeys } from "@/lib/agents/queries";
import { takeFailedStart } from "@/lib/channels/pending-start";
import { Route as HomeRoute } from "@/routes/_authed/_app/index";

beforeAll(() => GlobalRegistrator.register());

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
  cleanup();
  // A failed start waits in the tab for the next home page; each test is its own tab.
  takeFailedStart();
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
    isolated: false,
    isolationActive: false,
    isolationOffReason: null,
    hidden: false,
    pinned: false,
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
  // Home and the placeholder it opens on send, so a start that fails behind the placeholder comes
  // back to a freshly mounted home page, as it does in the app.
  const rootRoute = createRootRoute({ component: Outlet });
  const routeTree = rootRoute.addChildren([
    createRoute({
      getParentRoute: () => rootRoute,
      path: "/",
      component: HomeRoute.options.component,
    }),
    createRoute({
      getParentRoute: () => rootRoute,
      path: "/start/$startId",
      component: () => <p>Starting</p>,
    }),
  ]);
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  return Object.assign(
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    ),
    { router },
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

for (const refusal of [
  {
    status: 409,
    body: {
      error: "More than one coworker matches that name.",
      names: ["Data Analyst", "Risk Analyst"],
    },
    message: "Data Analyst, Risk Analyst",
  },
]) {
  test(`routing refusal ${refusal.status} preserves the draft and shows the explanation without starting a fallback`, async () => {
    const starts: string[][] = [];
    installHomeRoutingFetch({
      routeResponse: Response.json(refusal.body, { status: refusal.status }),
      starts,
    });
    const view = renderHome(
      queryClientWithAgents([
        agent({ id: "default", name: "Default", visibility: "public" }),
      ]),
    );
    await submitHomeMessage(view, "ask analyst");
    await waitFor(() =>
      expect(view.getByRole("alert").textContent).toContain(refusal.message),
    );
    expect(starts).toEqual([]);
    expect(view.getByRole("textbox", { name: "Message" }).textContent).toBe(
      "ask analyst",
    );
  });
}

test("send opens the placeholder at once, before a Bot is picked or a channel made", async () => {
  const asked: string[] = [];
  global.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      // Only the writes: the page's own reads (who is signed in, the roster) are not the start.
      if (init?.method === "POST")
        asked.push(typeof input === "string" ? input : input.toString());
      // Routing never answers: whatever is on screen got there without it.
      return new Promise<Response>(() => {});
    },
    { preconnect: originalFetch.preconnect },
  );
  const view = renderHome(
    queryClientWithAgents([
      agent({ id: "default", name: "Default", visibility: "public" }),
    ]),
  );

  await submitHomeMessage(view, "hello");

  expect(await view.findByText("Starting")).toBeTruthy();
  expect(asked).toEqual(["/api/route"]);
});

test("a start that fails after the person went back home shows its words and reason on that home page", async () => {
  // Routing answers only when told to, so the person can leave the placeholder before it does.
  let answer: (response: Response) => void = () => undefined;
  global.fetch = Object.assign(
    async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/route")
        return new Promise<Response>((resolve) => {
          answer = resolve;
        });
      throw new Error(`Unexpected fetch: ${url}`);
    },
    { preconnect: originalFetch.preconnect },
  );
  const view = renderHome(
    queryClientWithAgents([
      agent({ id: "default", name: "Default", visibility: "public" }),
    ]),
  );

  await submitHomeMessage(view, "ask analyst");
  expect(await view.findByText("Starting")).toBeTruthy();
  // Home's own link, while the Bot is still being picked: a home page mounted before the failure.
  await view.router.navigate({ to: "/" });
  await view.findByRole("textbox", { name: "Message" });

  answer(
    Response.json(
      {
        error: "More than one coworker matches that name.",
        names: ["Data Analyst", "Risk Analyst"],
      },
      { status: 409 },
    ),
  );

  await waitFor(() =>
    expect(view.getByRole("alert").textContent).toContain(
      "Data Analyst, Risk Analyst",
    ),
  );
  expect(view.getByRole("textbox", { name: "Message" }).textContent).toBe(
    "ask analyst",
  );
});

test("a start that fails while the person is writing something else on home leaves the box alone", async () => {
  let answer: (response: Response) => void = () => undefined;
  global.fetch = Object.assign(
    async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/route")
        return new Promise<Response>((resolve) => {
          answer = resolve;
        });
      throw new Error(`Unexpected fetch: ${url}`);
    },
    { preconnect: originalFetch.preconnect },
  );
  const view = renderHome(
    queryClientWithAgents([
      agent({ id: "default", name: "Default", visibility: "public" }),
    ]),
  );

  await submitHomeMessage(view, "ask analyst");
  expect(await view.findByText("Starting")).toBeTruthy();
  await view.router.navigate({ to: "/" });
  const user = userEvent.setup({ document: view.container.ownerDocument });
  await user.type(
    await view.findByRole("textbox", { name: "Message" }),
    "something new",
  );

  answer(
    Response.json(
      {
        error: "More than one coworker matches that name.",
        names: ["Data Analyst", "Risk Analyst"],
      },
      { status: 409 },
    ),
  );

  // Nothing to wait on but the failure itself; give it the turns it needs to land.
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(view.getByRole("textbox", { name: "Message" }).textContent).toBe(
    "something new",
  );
  // Kept for the next home page, which is not this test's to open.
  expect(takeFailedStart()?.text).toBe("ask analyst");
});
