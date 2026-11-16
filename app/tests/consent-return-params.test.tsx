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
import { Route as ConnectedAccountRoute } from "@/routes/_authed/_app/connections.$key";
import { Route as AdminAppRoute } from "@/routes/_authed/admin/plugins/$key";
import { ME_PATH } from "./accounts-api";
import { type AppsFixture, answerAppsApi, type TodayServer } from "./apps-api";
import {
  confirmationResponse,
  connectionPage,
  disconnectPreviewResponse,
  MY_CONNECTIONS_PATH,
} from "./connections-api";
import { answerNoTeamGrants } from "./team-grants-api";

/**
 * THE BROKER'S RETURN PARAMETERS ARE DROPPED FROM THE ADDRESS ONCE THE PAGE IS BACK, AND THE
 * ACCOUNT STILL READS CONNECTED.
 *
 * A consent at the app's broker sends the person back to the page they pressed Connect on with the
 * broker's own report appended: `?status=success&connected_account_id=…`, or `status=failed` when
 * they cancelled. The page never trusts that report (it asks the broker itself on arrival), so the
 * parameters are noise, and left in the address bar they ride along on every reload and every link
 * somebody copies. Both landing pages are pinned: the person's own app page and the admin's.
 *
 * Both halves are asserted, because a strip that also threw the page's state away would pass a
 * URL-only check: the address is clean AND the row says Connected.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(async () => {
  // Let React's scheduler drain before the DOM globals it reads go away.
  await new Promise((resolve) => setTimeout(resolve, 50));
  await GlobalRegistrator.unregister();
});

const APP = "composio-gmail";
const RETURN = "?status=success&connected_account_id=ca_e2e000000002";

function gmail(): TodayServer {
  return {
    authScheme: "OAUTH2",
    id: APP,
    title: "Gmail",
    vendor: "Google",
    url: "https://example.invalid/composio",
    summary: "Mail.",
    docsUrl: "",
    provenance: "composio",
    hasCredential: false,
    toolsRefreshedAt: null,
    lastError: null,
    addedBy: null,
    dynamicClient: false,
    accountMode: null,
    sharedVendorConnected: false,
    ownerGrants: "any",
    ownerGrantsChosen: null,
    tools: [],
    withdrawn: [],
  };
}

/** The API as it answers right after a consent the person allowed. */
function install() {
  const page: AppsFixture = {
    catalogue: [],
    servers: [gmail()],
    botsMayCallBack: true,
    redirectUri: null,
    composioConfigured: true,
    authorizesPerAction: false,
  };
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      headers: { "content-type": "application/json" },
      status,
    });
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input).split("?")[0] ?? "";
    if (path === ME_PATH)
      return json({ user: { id: "u", role: "admin", email: "u@x.io" } });
    const apps = answerAppsApi(input, init, page);
    if (apps) return apps;
    // The admin page's Teams row: no teams here, and the app granted to none.
    const teamGrants = answerNoTeamGrants(input, init);
    if (teamGrants) return teamGrants;
    if (path === MY_CONNECTIONS_PATH) {
      return connectionPage([
        {
          serverId: APP,
          connectedAt: "2026-11-15T01:39:19.849Z",
          verified: true,
          verifiedAt: "2026-11-15T01:39:19.848Z",
          checkable: true,
        },
      ]);
    }
    if (path.endsWith("/disconnect-preview"))
      return disconnectPreviewResponse({ siblings: [], unanswered: 0 });
    if (path.endsWith("/confirm")) return confirmationResponse(true);
    return json({ connections: [], grants: [], nextCursor: null });
  }) as typeof fetch;
}

type TestRouter = { state: { location: { search: unknown; href: string } } };

function renderAt(where: "settings" | "admin") {
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
  const listRoute = createRoute({
    path: "/connections/",
    getParentRoute: () => appRoute,
    component: () => null,
  });
  const accountRoute = (
    ConnectedAccountRoute as unknown as {
      update: (options: unknown) => typeof ConnectedAccountRoute;
    }
  ).update({
    id: "/connections/$key",
    path: "/connections/$key",
    getParentRoute: () => appRoute,
  });
  const adminRoute = (
    AdminAppRoute as unknown as {
      update: (options: unknown) => typeof AdminAppRoute;
    }
  ).update({
    id: "/admin/plugins/$key",
    path: "/admin/plugins/$key",
    getParentRoute: () => authedRoute,
  });
  const start =
    where === "settings"
      ? `/connections/${APP}${RETURN}`
      : `/admin/plugins/${APP}${RETURN}`;
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      authedRoute.addChildren([
        appRoute.addChildren([listRoute, accountRoute]),
        adminRoute,
      ]),
    ]),
    history: createMemoryHistory({ initialEntries: [start] }),
  });
  const view = render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
  return { view, router: router as unknown as TestRouter };
}

for (const where of ["settings", "admin"] as const) {
  const page =
    where === "settings" ? "the person's app page" : "the admin's app page";

  test(`back on ${page} from the broker, its report leaves the address and the account reads Connected`, async () => {
    install();
    const { view, router } = renderAt(where);

    await waitFor(() => expect(router.state.location.search).toEqual({}));
    expect(router.state.location.href).not.toContain("status=");
    expect(router.state.location.href).not.toContain("connected_account_id");

    await waitFor(() =>
      expect(view.container.textContent).toContain("Connected"),
    );
  });
}
