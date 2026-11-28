import { QueryClientProvider } from "@tanstack/react-query";
import {
  createBrowserHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { createRoot } from "react-dom/client";
import { AdminSidebar } from "@/components/admin/admin-sidebar";
import { SidebarShell } from "@/components/layout/sidebar-shell";
import { SidebarInset } from "@/components/ui/sidebar";
import { setCurrentOrganization } from "@/lib/organizations/current";
import { queryClient } from "@/query-client";
import { Route as ComputersRoute } from "@/routes/_authed/admin/computers";
import { Route as PermissionsRoute } from "@/routes/_authed/admin/permissions";
import { Route as DescribePermissionsRoute } from "@/routes/_authed/admin/permissions_.describe";
import { Route as AppRoute } from "@/routes/_authed/admin/plugins/$key";
import { Route as AppBotRoute } from "@/routes/_authed/admin/plugins/$key_.bots.$agentId";
import { Route as SkillRoute } from "@/routes/_authed/admin/skills_.$slug";
import { Route as WhatIfRoute } from "@/routes/_authed/admin/what-if";

/**
 * The Admin pages where a rule or a grant names a team, as a page of their own for
 * team-grants-screens-layout.test.tsx to bundle and load in a browser: Permissions and its
 * Describe page, Computers, What would happen, an app's page, an app's page for one Bot, and a
 * skill's page. Each is the app's own route, at its own address, in Admin's real frame (its sidebar
 * and inset panel, as `routes/_authed/admin/route.tsx` draws them). What the server answers comes
 * from the test's routes.
 *
 * The pages read their own route for the address's parameters and search, so the tree is built the
 * way `routeTree.gen.ts` builds it: a pathless `_authed`, `admin` under it, and each page under that
 * with the id and path the generated tree gives it. Admin's own guard is left out: there is no
 * sign-in in front of this page, and the test answers what the guard reads.
 *
 * The page starts in `default`, the organization those routes answer for, as every test does
 * (preload.ts, which a page loaded in a browser does not run).
 */
setCurrentOrganization("default");

const rootRoute = createRootRoute({ component: () => <Outlet /> });

const authedRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "_authed",
});

/** Admin's frame: the same sidebar and inset panel as the app's own Admin layout. */
const adminRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "admin",
  component: () => (
    <SidebarShell className="h-svh overflow-hidden">
      <AdminSidebar />
      <SidebarInset className="min-h-0 min-w-0 overflow-hidden">
        <Outlet />
      </SidebarInset>
    </SidebarShell>
  ),
});

/** One of the app's file routes, placed under Admin as the generated tree places it. */
const placed = (route: unknown, id: string, path: string) =>
  (route as { update: (options: unknown) => never }).update({
    id,
    path,
    getParentRoute: () => adminRoute,
  });

/** A page these screens link to and never open. */
const elsewhere = (path: string) =>
  createRoute({
    getParentRoute: () => adminRoute,
    path,
    component: () => null,
  });

const router = createRouter({
  history: createBrowserHistory(),
  routeTree: rootRoute.addChildren([
    authedRoute.addChildren([
      adminRoute.addChildren([
        placed(PermissionsRoute, "/permissions", "/permissions"),
        placed(
          DescribePermissionsRoute,
          "/permissions_/describe",
          "/permissions/describe",
        ),
        placed(ComputersRoute, "/computers", "/computers"),
        placed(WhatIfRoute, "/what-if", "/what-if"),
        placed(AppRoute, "/plugins/$key", "/plugins/$key"),
        placed(
          AppBotRoute,
          "/plugins/$key_/bots/$agentId",
          "/plugins/$key/bots/$agentId",
        ),
        placed(SkillRoute, "/skills_/$slug", "/skills/$slug"),
        elsewhere("/plugins"),
        elsewhere("/skills"),
        elsewhere("/audit"),
      ]),
    ]),
  ]),
});

const root = document.getElementById("root");
if (root)
  createRoot(root).render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
