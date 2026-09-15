import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
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
import {
  type PluginServer,
  type PluginsPage,
  type PluginTool,
  pluginKeys,
} from "@/lib/plugins/queries";
import { Route as BotAppRoute } from "@/routes/_authed/admin/plugins/$key_.bots.$agentId";

/**
 * What the per-Bot grant screen draws: which of its three pages a failed read returns, and the one
 * mark a row carries beyond the action's own name.
 *
 * Most of it is about the failure. Same mistake, same shape, as `agent-roster-error.test.tsx`: the screen branched on the app being
 * absent from `plugins.data`, and `isPending` goes false on a failed fetch exactly as it does on a
 * successful one — so a request that never came back was rendered as "this deployment has not
 * enabled an app by that name", about an app that may be enabled and granted right now. The Bot
 * half of the same function always got this right (`agents.data && !bot`), which is what made the
 * app half visible.
 *
 * The last case is no failure at all: the danger mark on a destructive action. It is here because
 * this is where the harness that draws this screen lives, and it needs both halves — the marked row
 * and the unmarked one — since `destructive: false` is the vendor making no claim rather than a
 * claim of safety, and a row that read as reassuring on that evidence would say more than anybody
 * knows. It draws off the same seeded page as the failed-refetch case above.
 *
 * `bot-app-grants.test.tsx` is the other half of this screen's coverage and deliberately renders
 * nothing — it asserts the bulk button's set through the exported `readOnlyRefs`. This file has to
 * draw, because what is under test is what reaches the page, so it is its own file rather than a
 * DOM smuggled into that one.
 *
 * THE HARNESS IS THIS REPOSITORY'S, copied from `agent-roster-error.test.tsx` for the reasons
 * recorded there: `GlobalRegistrator` in `beforeAll`/`afterAll`, `cleanup` in `afterEach`, queries
 * off `render()`'s own return, and a `QueryClient` with `retry: false` so a failing query settles
 * in one attempt.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

const originalFetch = global.fetch;

beforeEach(() => {
  // Every read in this app goes through `client()` in `lib/client.ts`, which throws once the
  // response is not `ok`. A 500 with no body is the shape a broken server actually sends.
  // `preconnect` carried over from the real one rather than cast away: `typeof fetch` has it, and a
  // cast to that type is a claim about a stub that does not.
  global.fetch = Object.assign(
    async () => new Response(null, { status: 500 }),
    {
      preconnect: originalFetch.preconnect,
    },
  );
});

afterEach(() => {
  global.fetch = originalFetch;
});

const APP_KEY = "slack";
const BOT_ID = "bot-1";

/** A client the failing queries settle on in one attempt, so no test waits on a retry. */
function failingQueryClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
}

/**
 * A client already holding a good plugins page under the exact key `pluginsPageQueryOptions()`
 * reads, built on `failingQueryClient()`.
 *
 * With this file's always-failing `fetch`, mounting against it reproduces a failed BACKGROUND
 * refetch: `refetchOnMount` fires because `staleTime` is 0, that fetch 500s, and `isError` goes
 * true while `data` stays exactly this seeded page. That is the state the screen must keep
 * rendering from — see `agent-roster-error.test.tsx`, which documents the query-core behaviour.
 */
function stalePluginsClient(page: PluginsPage) {
  const queryClient = failingQueryClient();
  queryClient.setQueryData(pluginKeys.page(), page);
  return queryClient;
}

/** A minimal but complete `PluginTool`, overridable per case. */
function tool(overrides: Partial<PluginTool> & { name: string }): PluginTool {
  return {
    serverId: APP_KEY,
    description: "Does something.",
    inputSchema: {},
    ref: `${APP_KEY}/${overrides.name}`,
    effect: "read",
    destructive: false,
    grantedTo: [],
    ...overrides,
  };
}

/** A minimal but complete `PluginServer`, overridable per case. */
function server(overrides: Partial<PluginServer> & { id: string }) {
  return {
    title: "Slack",
    vendor: "Slack",
    url: "https://example.invalid/mcp",
    summary: "Chat.",
    docsUrl: "https://example.invalid/docs",
    provenance: "first-party",
    hasCredential: true,
    toolsRefreshedAt: null,
    lastError: null,
    addedBy: null,
    dynamicClient: false,
    // Not brokered unless a case says otherwise, which is what a null means here.
    authScheme: null,
    tools: [],
    withdrawn: [],
    ...overrides,
  } satisfies PluginServer;
}

/** A minimal but complete `PluginsPage`, overridable per case. */
function pluginsPage(overrides: Partial<PluginsPage> = {}): PluginsPage {
  return {
    catalogue: [],
    servers: [],
    skills: [],
    botsMayCallBack: true,
    redirectUri: null,
    composioConfigured: false,
    ...overrides,
  };
}

/** Waits for the seeded query to have actually failed its background refetch, rather than trusting
 *  that the seeded data alone (which would render identically before any fetch ran) proves it. */
async function waitForFailedRefetch(queryClient: QueryClient) {
  await waitFor(() => {
    expect(queryClient.getQueryState(pluginKeys.page())?.status).toBe("error");
  });
}

/*
 * This screen's component calls `useParams({ from: "/_authed/admin/plugins/$key_/bots/$agentId" })`,
 * which resolves that id against the router's matched routes, so the tree has to produce exactly
 * that id — decoy pathless/static parents are enough, as `agent-roster-error.test.tsx` establishes,
 * and the real ancestors (a session check, the admin shell) are not what this file is about.
 *
 * `routeTree.gen.ts` fixes both halves: id `/plugins/$key_/bots/$agentId` under `/_authed/admin`,
 * path `/plugins/$key/bots/$agentId` — the trailing underscore opts the route out of nesting and
 * never appears in a URL.
 *
 * Capture and restore of the exported `Route` singleton is that file's scheme verbatim, and for its
 * reason: `.update()` merges into the live object and `createRouter()` derives `_id`/`parentRoute`
 * off it, so a render here would otherwise leave the real router (`router.test.ts` builds one in
 * this same bun process) pointed at a decoy parent.
 */
function captureRouteState(route: object): Record<string, unknown> {
  return { ...route, options: { ...(route as { options: object }).options } };
}

function restoreRouteState(
  route: object,
  snapshot: Record<string, unknown>,
): void {
  for (const key of Object.keys(route)) {
    if (!(key in snapshot)) {
      delete (route as Record<string, unknown>)[key];
    }
  }
  Object.assign(route, snapshot);
}

/** Captured once, at module scope, before any `test()` body in this file has run — the state this
 *  file must hand back, whatever it happens to be. See `agent-roster-error.test.tsx`. */
const pristineBotAppRouteState = captureRouteState(BotAppRoute);

let botAppRouteSnapshot: Record<string, unknown>;

beforeEach(() => {
  botAppRouteSnapshot = captureRouteState(pristineBotAppRouteState);
});

afterEach(() => {
  restoreRouteState(BotAppRoute, botAppRouteSnapshot);
});

function renderScreen(queryClient: QueryClient) {
  const rootRoute = createRootRoute({ component: Outlet });
  const authedRoute = createRoute({
    id: "/_authed",
    getParentRoute: () => rootRoute,
    component: Outlet,
  });
  const adminRoute = createRoute({
    path: "/admin",
    getParentRoute: () => authedRoute,
    component: Outlet,
  });
  // The two Back links this screen can draw. Registered so `Link` has a real route to build an
  // href from; neither is navigated to here.
  const pluginsRoute = createRoute({
    path: "/plugins/",
    getParentRoute: () => adminRoute,
    component: () => null,
  });
  const appRoute = createRoute({
    path: "/plugins/$key",
    getParentRoute: () => adminRoute,
    component: () => null,
  });
  const wired = (
    BotAppRoute as unknown as {
      update: (options: unknown) => typeof BotAppRoute;
    }
  ).update({
    id: "/plugins/$key_/bots/$agentId",
    path: "/plugins/$key/bots/$agentId",
    getParentRoute: () => adminRoute,
  });
  const tree = rootRoute.addChildren([
    authedRoute.addChildren([
      adminRoute.addChildren([pluginsRoute, appRoute, wired]),
    ]),
  ]);
  const router = createRouter({
    routeTree: tree,
    history: createMemoryHistory({
      initialEntries: [`/admin/plugins/${APP_KEY}/bots/${BOT_ID}`],
    }),
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

test("a failed plugin read reports the failure instead of claiming the app is not enabled", async () => {
  const view = renderScreen(failingQueryClient());

  expect(await view.findByText("Plugins could not be loaded.")).toBeTruthy();

  // The whole point: an app that may be enabled, with grants on it right now, must never be
  // reported as absent on the evidence of a request that never came back.
  expect(
    view.queryByText("This deployment has not enabled an app by that name."),
  ).toBeNull();
  expect(view.queryByText("There is nothing here to grant.")).toBeNull();
});

test("a failed plugin read draws no switches, so nothing reads as a Bot holding nothing", async () => {
  const view = renderScreen(failingQueryClient());

  await view.findByText("Plugins could not be loaded.");

  expect(view.container.querySelectorAll('[role="switch"]').length).toBe(0);
  expect(view.queryByText("Turn on every read-only action")).toBeNull();
  // The two section headings the grant list is drawn under: neither belongs on a page built from
  // an answer that never arrived.
  expect(view.queryByText("Reads")).toBeNull();
  expect(view.queryByText("Changes things")).toBeNull();
});

test("an answer that genuinely lacks the app still says the app is not enabled", async () => {
  // Seeded, so `plugins.data` is a real answer; the refetch on mount still fails, which is what
  // separates "the list came back without it" from "the list never came back".
  const queryClient = stalePluginsClient(pluginsPage());

  const view = renderScreen(queryClient);
  await waitForFailedRefetch(queryClient);

  expect(
    await view.findByText(
      "This deployment has not enabled an app by that name.",
    ),
  ).toBeTruthy();
  expect(view.queryByText("Plugins could not be loaded.")).toBeNull();
});

test("a failed REFETCH keeps the grant list it already had, not the error", async () => {
  const queryClient = stalePluginsClient(
    pluginsPage({
      servers: [
        server({
          id: APP_KEY,
          tools: [tool({ name: "list_channels" })],
        }),
      ],
    }),
  );

  const view = renderScreen(queryClient);
  await waitForFailedRefetch(queryClient);

  expect(await view.findByText("list_channels")).toBeTruthy();
  expect(view.queryByText("Plugins could not be loaded.")).toBeNull();
  expect(
    view.queryByText("This deployment has not enabled an app by that name."),
  ).toBeNull();
});

/**
 * The actions end of one action's row: its switch, and whatever is drawn beside it.
 *
 * Reached through the switch's own label because a row carries no test id, and the label is the
 * only thing on it that names the action uniquely. The roster never comes back in this file, so the
 * Bot's name in that label falls back to its id, which is what the screen itself does.
 */
function rowActions(view: ReturnType<typeof renderScreen>, name: string) {
  const actions = view
    .getByLabelText(`Let ${BOT_ID} call ${name}`)
    .closest('[data-slot="item-actions"]');
  if (!actions) throw new Error(`No row drawn for ${name}.`);
  return actions;
}

test("an action the vendor calls destructive is marked, and a write it says nothing about is not", async () => {
  const queryClient = stalePluginsClient(
    pluginsPage({
      servers: [
        server({
          id: APP_KEY,
          tools: [
            tool({ effect: "write", name: "post_message" }),
            tool({
              destructive: true,
              effect: "write",
              name: "delete_channel",
            }),
          ],
        }),
      ],
    }),
  );

  const view = renderScreen(queryClient);
  await waitForFailedRefetch(queryClient);
  await view.findByText("delete_channel");

  // The mark itself, on the row that earned it: the heading already says these rows change things,
  // and this is the one saying what this row changes does not come back.
  expect(rowActions(view, "delete_channel").textContent).toContain(
    "destroys things",
  );

  // The other half, which matters as much. `destructive: false` is the vendor having made no claim,
  // not a claim that nothing is lost — so nothing at all goes beside this switch. A word here, of
  // any colour, would be the page vouching for an action on evidence it does not have.
  expect(rowActions(view, "post_message").textContent).toBe("");
});
