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
import { MovedElsewhereBanner } from "@/components/moves/moved-elsewhere-banner";
import { SettingsSidebar } from "@/components/settings/settings-sidebar";
import { ThemeProvider } from "@/components/theme-provider";
import { SidebarInset } from "@/components/ui/sidebar";
import { signedInUser } from "@/lib/auth/queries";
import { queryClient } from "@/query-client";
import { Route as ComputerRoute } from "@/routes/_authed/settings/computer";

/**
 * OpenBot Cloud after a move, for moved-elsewhere.test.tsx to bundle and load in a browser:
 *
 * - `/`: the app's page inset as `_authed/_app` draws it, its bars over the page, with the bar
 *   that says where the person's moved Bots are. The page itself is a stand-in heading.
 * - `/settings/computer`: Settings → Computer in the app's real settings frame, inside OpenBot
 *   Desktop connected to OpenBot Cloud. The desktop app is the test's `__TAURI_INTERNALS__`.
 *
 * The organization the page works in is the server's answer, as on a real first load.
 */
// The `_authed` gate's first step: who is signed in, and the organization they work in.
const rootRoute = createRootRoute({
  beforeLoad: () => signedInUser(queryClient),
  component: () => <Outlet />,
});

const appRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: () => (
    <SidebarShell className="h-svh overflow-hidden">
      <SidebarInset className="min-h-0 overflow-hidden">
        <MovedElsewhereBanner />
        <main className="p-8">
          <h1 className="text-2xl font-semibold">Home</h1>
        </main>
      </SidebarInset>
    </SidebarShell>
  ),
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
  routeTree: rootRoute.addChildren([
    appRoute,
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
