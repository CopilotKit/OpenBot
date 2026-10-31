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
import { cleanup, render } from "@testing-library/react";
import type { PluginServer, PluginsPage } from "@/lib/plugins/queries";
import { Route as AdminAppRoute } from "@/routes/_authed/admin/plugins/$key";
import { Route as BotAppRoute } from "@/routes/_authed/admin/plugins/$key_.bots.$agentId";
import { settleReactWork } from "./settle-react-work";

/**
 * The two pages where an administrator presses Refresh, after a refresh that left an action out.
 *
 * `skipped-tools-notice.test.tsx` pins what the warning says. This pins that each page draws it: the
 * app's own page and the Bot's grant page for that app. Before the warning existed, the names rode
 * in `lastError`, which these pages drew only when the app had no tools at all, so after a partial
 * refresh the administrator who pressed Refresh saw nothing.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const APP = "notion";
const BOT = "bot-1";
const SKIPPED = "notion.export";
const KEPT = "notion-fetch";

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
const routes = [AdminAppRoute, BotAppRoute];
const pristine = routes.map(captureRouteState);
let snapshots: Record<string, unknown>[] = [];
beforeEach(() => {
  snapshots = pristine.map(captureRouteState);
});
afterEach(() => {
  routes.forEach((route, index) => {
    restoreRouteState(route, snapshots[index] ?? {});
  });
});

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
});

/** An app whose last refresh stored one action and skipped one, as the server reports it. */
function server(): PluginServer {
  return {
    id: APP,
    title: "Notion",
    vendor: "Notion",
    url: "https://example.invalid/mcp",
    summary: "Docs.",
    docsUrl: "",
    provenance: "custom",
    hasCredential: true,
    toolsRefreshedAt: "2026-10-21T00:00:00.000Z",
    lastError: null,
    addedBy: null,
    dynamicClient: false,
    accountMode: null,
    sharedVendorConnected: false,
    ownerGrants: "any",
    ownerGrantsChosen: null,
    authScheme: null,
    tools: [
      {
        serverId: APP,
        name: KEPT,
        description: "Reads a page.",
        inputSchema: {},
        ref: `${APP}/${KEPT}`,
        effect: "read",
        destructive: false,
        grantedTo: [],
      },
    ],
    withdrawn: [],
    skippedTools: [SKIPPED],
  };
}

function install() {
  const page: PluginsPage = {
    catalogue: [],
    servers: [server()],
    skills: [],
    botsMayCallBack: true,
    redirectUri: null,
    composioConfigured: false,
    authorizesPerAction: false,
  };
  global.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0]) => {
      const path = String(input).split("?")[0] ?? "";
      if (path === "/api/plugins") return Response.json(page);
      if (path.startsWith("/api/plugins/connections"))
        return Response.json({ connections: [], redirectUri: null });
      if (path.startsWith("/api/agents"))
        return Response.json({
          agents: [
            { id: BOT, name: "Helper", hidden: false, hasCallbackToken: false },
          ],
        });
      return Response.json({ error: "unexpected" }, { status: 404 });
    },
    { preconnect: originalFetch.preconnect },
  );
}

type Updatable = { update: (options: unknown) => unknown };

function renderAt(at: string) {
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
  const pluginsRoute = createRoute({
    path: "/plugins/",
    getParentRoute: () => adminRoute,
    component: () => null,
  });
  const app = (AdminAppRoute as unknown as Updatable).update({
    id: "/plugins/$key",
    path: "/plugins/$key",
    getParentRoute: () => adminRoute,
  });
  const bot = (BotAppRoute as unknown as Updatable).update({
    id: "/plugins/$key_/bots/$agentId",
    path: "/plugins/$key/bots/$agentId",
    getParentRoute: () => adminRoute,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      authedRoute.addChildren([
        adminRoute.addChildren([pluginsRoute, app as never, bot as never]),
      ]),
    ]),
    history: createMemoryHistory({ initialEntries: [at] }),
  });
  return render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

/** The warning on the page, found by what it says rather than by where it sits. */
async function warning(view: ReturnType<typeof render>) {
  await view.findByText(KEPT);
  const notice = view
    .getAllByRole("status")
    .find((element) => element.textContent?.includes("was left out"));
  return notice?.textContent ?? null;
}

test("the app's own page names the action its last refresh left out", async () => {
  install();
  const view = renderAt(`/admin/plugins/${APP}`);
  expect(await warning(view)).toContain(SKIPPED);
});

test("the Bot's grant page for the app names the action its last refresh left out", async () => {
  install();
  const view = renderAt(`/admin/plugins/${APP}/bots/${BOT}`);
  expect(await warning(view)).toContain(SKIPPED);
});
