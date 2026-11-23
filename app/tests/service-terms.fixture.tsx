import { QueryClientProvider } from "@tanstack/react-query";
import {
  createBrowserHistory,
  createRootRouteWithContext,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { createRoot } from "react-dom/client";
import { ThemeProvider } from "@/components/theme-provider";
import { setCurrentOrganization } from "@/lib/organizations/current";
import { queryClient } from "@/query-client";
import type { RouterContext } from "@/router-context";
import { Route as AuthedRoute } from "@/routes/_authed";
import { Route as OnboardingRoute } from "@/routes/_authed/onboarding";
import { Route as TermsRoute } from "@/routes/_authed/terms";

/**
 * The signed-in gate, the terms screen and onboarding, for service-terms.test.tsx to bundle and
 * load in a browser. The gate is `_authed`'s own `beforeLoad`, and the terms screen and onboarding
 * are their own routes, so where a person is sent is what the app does. Home and Settings behind the
 * gate are pages that say their names: this is about getting there. What the server answers comes
 * from the test's routes.
 *
 * Started in `default`, the organization those routes answer for, as every test does.
 */
setCurrentOrganization("default");

const rootRoute = createRootRouteWithContext<RouterContext>()({
  component: () => <Outlet />,
});

const authedRoute = createRoute({
  id: "/_authed",
  getParentRoute: () => rootRoute,
  // The app's own gate, as it runs in front of every signed-in page.
  beforeLoad: async (options) => {
    await (
      AuthedRoute.options.beforeLoad as unknown as (
        given: typeof options,
      ) => Promise<void>
    )(options);
  },
  component: () => <Outlet />,
});

const mounted = <T,>(route: T, path: string) =>
  (route as unknown as { update: (options: unknown) => T }).update({
    id: path,
    path,
    getParentRoute: () => authedRoute,
  });

const router = createRouter({
  history: createBrowserHistory(),
  context: { queryClient },
  routeTree: rootRoute.addChildren([
    authedRoute.addChildren([
      mounted(TermsRoute, "/terms") as never,
      mounted(OnboardingRoute, "/onboarding") as never,
      createRoute({
        getParentRoute: () => authedRoute,
        path: "/settings",
        component: () => <h1 data-app-settings="">Settings</h1>,
      }),
      createRoute({
        getParentRoute: () => authedRoute,
        path: "/",
        component: () => <h1 data-app-home="">Home</h1>,
      }),
    ]),
  ]),
});

const root = document.getElementById("root");
if (root)
  createRoot(root).render(
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <RouterProvider router={router as never} />
      </ThemeProvider>
    </QueryClientProvider>,
  );
