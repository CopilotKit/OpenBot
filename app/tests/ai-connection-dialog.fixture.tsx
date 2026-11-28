import { QueryClientProvider } from "@tanstack/react-query";
import {
  createBrowserHistory,
  createRootRoute,
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
import { Route as ApiKeysRoute } from "@/routes/_authed/settings/api-keys";
import { Route as SettingsProvidersRoute } from "@/routes/_authed/settings/providers";

/**
 * Settings, AI providers, in the app's real settings frame (its sidebar and inset panel, as
 * `routes/_authed/settings/route.tsx` draws them), for ai-connection-dialog.test.tsx to bundle and
 * load in a browser. API keys is beside it, a Settings page from before with a dialog of its own, to
 * look at next to the AI connection dialog. What the server answers comes from the test's routes.
 *
 * Started in `default`, the organization those routes answer for, as every test does.
 */
setCurrentOrganization("default");

const component = (route: { options: { component?: unknown } }) =>
  route.options.component as () => ReactNode;

const rootRoute = createRootRoute({ component: () => <Outlet /> });

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

const settings = (path: string, page: () => ReactNode) =>
  createRoute({ getParentRoute: () => settingsRoute, path, component: page });

const router = createRouter({
  history: createBrowserHistory(),
  routeTree: rootRoute.addChildren([
    settingsRoute.addChildren([
      settings("/settings/providers", component(SettingsProvidersRoute)),
      settings("/settings/api-keys", component(ApiKeysRoute)),
    ]),
    createRoute({
      getParentRoute: () => rootRoute,
      path: "/",
      component: () => null,
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
