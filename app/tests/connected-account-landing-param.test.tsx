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
import type { GrantState } from "@/lib/plugins/grants";
import type { PluginServer, PluginsPage } from "@/lib/plugins/queries";
import { Route as ConnectedAccountRoute } from "@/routes/_authed/_app/connections.$key";

/**
 * `?action=` IS DROPPED FROM THE URL AFTER ITS ONE READ, AND THE GRANT LIST STILL MARKS ITS ROW.
 *
 * The parameter's only sender is the per-action verifier's redirect, so it reports a consent that
 * has just completed. Left in the address bar it is read again on every reload and back-navigation,
 * and "You just authorized X" is redrawn about a consent that may be hours old.
 *
 * BOTH HALVES ARE PINNED, because the value feeds two readers: the landing notice and the grant
 * list's `data-landed` mark. A strip that reads the value live would pass a URL-only assertion and
 * leave the grant list with nothing marked; a mark that works off the URL would pass a mark-only
 * assertion and replay forever. The grants read here is HELD until the URL has been stripped, so
 * the list is drawn strictly after the parameter is gone — the order a slow vendor read produces in
 * production, and the one in which a live read of `?action=` marks nothing.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(async () => {
  // Let React's scheduler drain before the DOM globals it reads go away.
  await new Promise((resolve) => setTimeout(resolve, 50));
  await GlobalRegistrator.unregister();
});

const APP = "gmail";

const GMAIL: GrantState[] = [
  {
    action: "Gmail.ListEmails",
    state: "authorized",
    scopes: ["gmail.readonly"],
    authorization: "held",
  },
  { action: "Gmail.SendEmail", state: "needs-consent", scopes: ["gmail.send"] },
];

function server(accountMode: "shared" | null): PluginServer {
  return {
    authScheme: "OAUTH2",
    id: APP,
    title: "Gmail",
    vendor: "Google",
    url: "arcade://gmail",
    summary: "Mail.",
    docsUrl: "",
    provenance: "arcade",
    hasCredential: false,
    toolsRefreshedAt: null,
    lastError: null,
    addedBy: null,
    dynamicClient: false,
    accountMode,
    sharedVendorConnected: false,
    ownerGrants: "any",
    ownerGrantsChosen: null,
    tools: [],
    withdrawn: [],
  };
}

/** Installs the API, with the grants read answering only once `release` is called. */
function install(accountMode: "shared" | null) {
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const page: PluginsPage = {
    catalogue: [],
    servers: [server(accountMode)],
    skills: [],
    botsMayCallBack: true,
    redirectUri: null,
    composioConfigured: true,
    authorizesPerAction: true,
    provider: "arcade",
  };
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      headers: { "content-type": "application/json" },
      status,
    });
  global.fetch = (async (input: RequestInfo | URL) => {
    const path = String(input).split("?")[0] ?? "";
    if (path.endsWith("/grants")) {
      await held;
      return json({ actions: GMAIL });
    }
    if (path === "/api/me")
      return json({ user: { id: "u", role: "admin", email: "u@x.io" } });
    if (path === "/api/plugins") return json(page);
    if (path.startsWith("/api/plugins/connections")) {
      return json({
        connections:
          accountMode === "shared"
            ? []
            : [
                {
                  serverId: APP,
                  scope: "",
                  connectedAt: "2026-09-10T00:00:00.000Z",
                  verified: true,
                  verifiedAt: null,
                  checkable: false,
                },
              ],
        redirectUri: null,
      });
    }
    if (path.endsWith("/connection/siblings"))
      return json({ siblings: [], unanswered: 0 });
    if (path.endsWith("/connection/confirm")) return json({ connected: true });
    return json({ error: "unexpected" }, 404);
  }) as typeof fetch;
  return { release: () => release() };
}

type TestRouter = { state: { location: { search: unknown } } };

function renderScreen(search: string) {
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
  const indexRoute = createRoute({
    path: "/connections/",
    getParentRoute: () => appRoute,
    component: () => null,
  });
  const wired = (
    ConnectedAccountRoute as unknown as {
      update: (options: unknown) => typeof ConnectedAccountRoute;
    }
  ).update({
    id: "/connections/$key",
    path: "/connections/$key",
    getParentRoute: () => appRoute,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      authedRoute.addChildren([appRoute.addChildren([indexRoute, wired])]),
    ]),
    history: createMemoryHistory({
      initialEntries: [`/connections/${APP}${search}`],
    }),
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

function rowOf(view: ReturnType<typeof render>, action: string) {
  return view.container.querySelector<HTMLElement>(`[data-action="${action}"]`);
}

for (const accountMode of [null, "shared"] as const) {
  const which = accountMode === "shared" ? "a Shared app" : "a personal app";

  test(`on ${which}, ?action= is dropped from the URL and its row is still marked`, async () => {
    const api = install(accountMode);
    const { view, router } = renderScreen("?action=Gmail.ListEmails");

    // Half one: the parameter stops replaying — the URL no longer carries it.
    await waitFor(() => expect(router.state.location.search).toEqual({}));

    // The notice survives the strip.
    const notice = await view.findByRole("status");
    expect(notice.textContent).toBe("You just authorized Gmail.ListEmails.");

    // Half two: the grant list, drawn only now — after the strip — still marks the landed row.
    api.release();
    await waitFor(() => expect(rowOf(view, "Gmail.ListEmails")).not.toBeNull());
    expect(rowOf(view, "Gmail.ListEmails")?.hasAttribute("data-landed")).toBe(
      true,
    );
    expect(rowOf(view, "Gmail.SendEmail")?.hasAttribute("data-landed")).toBe(
      false,
    );
  });
}

test("with no ?action= nothing is marked and nothing is said", async () => {
  const api = install(null);
  const { view, router } = renderScreen("");
  api.release();
  await waitFor(() => expect(rowOf(view, "Gmail.ListEmails")).not.toBeNull());
  expect(router.state.location.search).toEqual({});
  expect(view.container.querySelector("[data-landed]")).toBeNull();
  expect(view.container.textContent).not.toContain("just authorized");
});
