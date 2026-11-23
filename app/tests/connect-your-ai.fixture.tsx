import { QueryClientProvider } from "@tanstack/react-query";
import {
  createBrowserHistory,
  createRootRouteWithContext,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { SidebarShell } from "@/components/layout/sidebar-shell";
import { OrganizationBoundary } from "@/components/organizations/organization-boundary";
import { useSwitchOrganization } from "@/components/organizations/use-switch-organization";
import { SettingsSidebar } from "@/components/settings/settings-sidebar";
import { ThemeProvider } from "@/components/theme-provider";
import { SidebarInset } from "@/components/ui/sidebar";
import {
  setCurrentOrganization,
  useCurrentOrganizationId,
} from "@/lib/organizations/current";
import { queryClient } from "@/query-client";
import type { RouterContext } from "@/router-context";
import { Route as AuthedRoute } from "@/routes/_authed";
import { Route as OnboardingRoute } from "@/routes/_authed/onboarding";
import { Route as GeneralRoute } from "@/routes/_authed/settings/index";

/**
 * The signed-in gate, onboarding and Settings → General, for connect-your-ai.test.tsx to bundle and
 * load in a browser. The gate is `_authed`'s own `beforeLoad`, and onboarding is its own route, so
 * where a person is sent is what the app does. The app behind the gate is a page that says Home:
 * this is about getting there. What the server answers comes from the test's routes.
 *
 * Started in `default`, the organization those routes answer for, as every test does.
 */
setCurrentOrganization("default");

const component = (route: { options: { component?: unknown } }) =>
  route.options.component as () => ReactNode;

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
  // The app's own boundary: built again for each organization, and the gates decide again in it.
  component: () => (
    <OrganizationBoundary>
      <Outlet />
    </OrganizationBoundary>
  ),
});

/**
 * Home, with the account menu's switch to another organization: the same hook the menu runs, so a
 * switch goes the way it does in the app (home first, then the app changes over).
 */
function Home() {
  const switching = useSwitchOrganization();
  // Which organization's home this is: the one the app works in.
  const organization = useCurrentOrganizationId();
  return (
    <main>
      <h1 data-app-home="" data-organization={organization}>
        Home
      </h1>
      <button onClick={() => switching.run("acme")} type="button">
        Work in Acme
      </button>
    </main>
  );
}

/**
 * An app's page, as the move's Reconnect opens it (`/connections/<app>`): a stand-in that says which
 * app it is. What matters here is that the gate gets the person to it.
 */
const appRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/connections/$key",
  component: function AppPage() {
    const { key } = appRoute.useParams();
    return <h1 data-app-connect={key}>{key}</h1>;
  },
});

const onboardingRoute = (
  OnboardingRoute as unknown as {
    update: (options: unknown) => typeof OnboardingRoute;
  }
).update({
  id: "/onboarding",
  path: "/onboarding",
  getParentRoute: () => authedRoute,
});

const settingsRoute = createRoute({
  getParentRoute: () => authedRoute,
  id: "settings-frame",
  component: () => (
    <SidebarShell className="h-svh overflow-hidden">
      <SettingsSidebar />
      <SidebarInset className="min-h-0 min-w-0 overflow-hidden">
        <Outlet />
      </SidebarInset>
    </SidebarShell>
  ),
});

const router = createRouter({
  history: createBrowserHistory(),
  context: { queryClient },
  routeTree: rootRoute.addChildren([
    authedRoute.addChildren([
      onboardingRoute as never,
      appRoute,
      settingsRoute.addChildren([
        createRoute({
          getParentRoute: () => settingsRoute,
          path: "/settings",
          component: component(GeneralRoute),
        }),
      ]),
      createRoute({
        getParentRoute: () => authedRoute,
        path: "/",
        component: Home,
      }),
    ]),
    createRoute({
      getParentRoute: () => rootRoute,
      path: "/sign",
      component: () => <h1 data-sign-in="">Sign in</h1>,
    }),
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
