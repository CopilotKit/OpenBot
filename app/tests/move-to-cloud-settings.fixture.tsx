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
import { Route as ComputerRoute } from "@/routes/_authed/settings/computer";

/**
 * Settings → Computer in the app's real settings frame, inside OpenBot Desktop with OpenBot on this
 * computer, for move-to-cloud-settings.test.tsx to bundle and load in a browser. The desktop app is
 * the test's `__TAURI_INTERNALS__`, and the server its routes.
 */
setCurrentOrganization("default");

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

const router = createRouter({
  history: createBrowserHistory(),
  routeTree: rootRoute.addChildren([
    settingsRoute.addChildren([
      createRoute({
        getParentRoute: () => settingsRoute,
        path: "/settings/computer",
        component: ComputerRoute.options.component as () => ReactNode,
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
