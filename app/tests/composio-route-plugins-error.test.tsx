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
import { cleanup, render } from "@testing-library/react";
import { Route as ComposioRoute } from "@/routes/_authed/admin/plugins/composio";

/**
 * A FAILED `/api/plugins` READ SAYS SO, rather than drawing a blank page.
 *
 * The route holds back until the plugins page names the provider, and `useQuery` leaves `data`
 * undefined permanently on an error, so without its own branch the gate answers "pending" forever.
 * The directory must also stay undrawn: it would request apps from a provider nobody confirmed.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
});

const requested: string[] = [];

/*
 * Capture and restore of the exported `Route` singleton, verbatim from `agent-roster-error.test.tsx`
 * and `brokered-account-row.test.tsx` and for the reason recorded there: `.update()` merges into the
 * live object, `createRouter()` derives `_id`/`parentRoute` off it, and nothing re-runs `init()` on
 * a replay — so a render here would otherwise leave the real router pointed at a decoy parent.
 */
const originalOptions = { ...ComposioRoute.options };
afterEach(() => {
  Object.assign(ComposioRoute.options, originalOptions);
});

function renderPicker() {
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
  const wired = (
    ComposioRoute as unknown as {
      update: (options: unknown) => typeof ComposioRoute;
    }
  ).update({
    id: "/plugins/composio",
    path: "/plugins/composio",
    getParentRoute: () => adminRoute,
  });
  const tree = rootRoute.addChildren([
    authedRoute.addChildren([adminRoute.addChildren([pluginsRoute, wired])]),
  ]);
  const router = createRouter({
    routeTree: tree,
    history: createMemoryHistory({
      initialEntries: ["/admin/plugins/composio"],
    }),
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

test("a failed plugins read renders an alert and never asks for the directory", async () => {
  requested.length = 0;
  global.fetch = (async (input: RequestInfo | URL) => {
    const path = String(input).split("?")[0] ?? "";
    requested.push(path);
    return new Response(JSON.stringify({ error: "boom" }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;

  const view = renderPicker();

  const alert = await view.findByRole("alert");
  expect(alert.textContent).toContain("Couldn't load the plugin settings");
  expect(view.queryByLabelText("Search Composio apps")).toBeNull();
  expect(requested).toContain("/api/plugins");
  expect(requested).not.toContain("/api/plugins/composio/apps");
});
