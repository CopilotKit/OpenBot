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
import { SettingsSidebar } from "@/components/settings/settings-sidebar";
import { ThemeProvider } from "@/components/theme-provider";
import { SidebarInset } from "@/components/ui/sidebar";
import { setCurrentOrganization } from "@/lib/organizations/current";
import { queryClient } from "@/query-client";
import type { RouterContext } from "@/router-context";
import { Route as ProvidersRoute } from "@/routes/_authed/admin/providers";
import { Route as AdminRoute } from "@/routes/_authed/admin/route";
import { Route as SettingsProvidersRoute } from "@/routes/_authed/settings/providers";

/**
 * Admin → AI providers in Admin's real frame and behind Admin's own gate (`admin/route.tsx`), and
 * Settings → AI providers beside it, for admin-providers-connection.test.tsx to bundle and load in a
 * browser. Anyone the gate turns away lands on a page that says Home. What the server answers
 * comes from the test's routes.
 *
 * Started in `default`, the organization those routes answer for, as every test does.
 */
setCurrentOrganization("default");

const component = (route: { options: { component?: unknown } }) =>
  route.options.component as () => ReactNode;

const rootRoute = createRootRouteWithContext<RouterContext>()({
  component: () => <Outlet />,
});

const adminRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/admin",
  // Admin's own gate: an admin, or back to Home.
  beforeLoad: async (options) => {
    await (
      AdminRoute.options.beforeLoad as unknown as (
        given: typeof options,
      ) => Promise<void>
    )(options);
  },
  component: component(AdminRoute),
});

const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
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
    adminRoute.addChildren([
      createRoute({
        getParentRoute: () => adminRoute,
        path: "/providers",
        component: component(ProvidersRoute),
      }),
    ]),
    settingsRoute.addChildren([
      createRoute({
        getParentRoute: () => settingsRoute,
        path: "/settings/providers",
        component: component(SettingsProvidersRoute),
      }),
    ]),
    createRoute({
      getParentRoute: () => rootRoute,
      path: "/",
      component: () => (
        <main>
          <h1 data-app-home="">Home</h1>
        </main>
      ),
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
