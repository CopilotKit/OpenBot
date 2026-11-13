import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  MutationObserver,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { BotRoster } from "@/components/bots/bot-roster";
import {
  createAgentMutationOptions,
  deleteAgentMutationOptions,
} from "@/lib/agents/mutations";
import {
  getBotsMock,
  getCreateBotMockHandler,
  getCreateBotResponseMock,
} from "@/lib/api/generated/bots/bots.msw";
import { settleReactWork } from "./settle-react-work";

/**
 * The Bots screen reads and writes through the client generated from api/openapi.yaml, and only
 * through it.
 *
 * The server here is the spec's own: the MSW handlers Orval generates beside the client, answering
 * at the API's addresses (`/api/v2/organizations/{organizationId}/bots`) with the spec's examples.
 * This is the screen talking to the API as the server serves it. A request to `/api/agents` is
 * recorded and fails the test, so a hand-written fetch or an old address left behind cannot pass.
 */

const requests: string[] = [];
const server = setupServer(
  ...getBotsMock(),
  // What else the roster reads. None of it is a Bots operation, so none of it is in the spec yet.
  http.get("*/api/bots/attention", () =>
    HttpResponse.json({ bots: [], lastPingId: null }),
  ),
  http.get("*/api/proactive/suggestions", () =>
    HttpResponse.json({ suggestions: [] }),
  ),
  http.get("*/api/tasks", () => HttpResponse.json({ tasks: [] })),
  http.get("*/api/channels", () =>
    HttpResponse.json({ channels: [], nextCursor: null }),
  ),
  // Everything else the page around it asks for is not this test's business, and is not found.
  http.all("*", () => new HttpResponse(null, { status: 404 })),
);
server.events.on("request:start", ({ request }) => {
  const url = new URL(request.url);
  requests.push(`${request.method} ${url.pathname}${url.search}`);
});

beforeAll(() => {
  // An address for the page, so the app's relative requests resolve as they do in a browser.
  GlobalRegistrator.register({ url: "http://openbot.invalid/" });
  server.listen({ onUnhandledRequest: "error" });
});
afterEach(() => {
  cleanup();
  server.resetHandlers();
  requests.length = 0;
});
afterAll(async () => {
  server.close();
  await settleReactWork();
  GlobalRegistrator.unregister();
});

function draw(queryClient: QueryClient) {
  const rootRoute = createRootRoute();
  const routeTree = rootRoute.addChildren([
    createRoute({
      getParentRoute: () => rootRoute,
      path: "/",
      component: BotRoster,
    }),
    createRoute({
      getParentRoute: () => rootRoute,
      path: "/bots/$agentId",
      component: () => null,
    }),
  ]);
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

function freshClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

test("the Bots roster lists the Bots the API returns, read at the API's address", async () => {
  const view = draw(freshClient());

  // The spec's own example Bot, served by the generated mock.
  const row = (await view.findByText("General Assistant")).closest("a");
  expect(row?.getAttribute("href")).toBe("/bots/general-assistant");

  const bots = requests.filter((line) => line.includes("bots?"));
  expect(bots).toContain("GET /api/v2/organizations/default/bots?limit=100");
  expect(bots).toContain(
    "GET /api/v2/organizations/default/bots?hidden=true&limit=100",
  );
  expect(requests.filter((line) => line.includes("/api/agents"))).toEqual([]);
});

test("creating and deleting a Bot are writes at the API's address, each with its own Idempotency-Key", async () => {
  const keys: string[] = [];
  const bodies: unknown[] = [];
  server.use(
    getCreateBotMockHandler(async ({ request }) => {
      keys.push(request.headers.get("idempotency-key") ?? "");
      bodies.push(await request.json());
      return getCreateBotResponseMock();
    }),
    http.delete(
      "*/api/v2/organizations/:organizationId/bots/:botId",
      ({ request, params }) => {
        keys.push(request.headers.get("idempotency-key") ?? "");
        expect(params.botId).toBe("agent/with a slash");
        return new HttpResponse(null, { status: 204 });
      },
    ),
  );
  const queryClient = freshClient();
  const input = {
    name: "Expense Review",
    title: "Finance Operations",
    roleDescription: "Review receipts.",
    visibility: "private" as const,
  };

  const created = await new MutationObserver(
    queryClient,
    createAgentMutationOptions(queryClient),
  ).mutate(input);
  expect(created.id).toBe(getCreateBotResponseMock().bot.id);
  expect(bodies).toEqual([input]);

  await new MutationObserver(
    queryClient,
    deleteAgentMutationOptions(queryClient),
  ).mutate("agent/with a slash");

  expect(requests).toContain("POST /api/v2/organizations/default/bots");
  // An id from a package stays one path segment.
  expect(requests).toContain(
    "DELETE /api/v2/organizations/default/bots/agent%2Fwith%20a%20slash",
  );
  expect(requests.filter((line) => line.includes("/api/agents"))).toEqual([]);
  expect(keys).toHaveLength(2);
  for (const key of keys) expect(key).toMatch(/^[0-9a-f]{32}$/);
  expect(new Set(keys).size).toBe(2);
});
