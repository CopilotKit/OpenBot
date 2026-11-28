import { QueryClientProvider } from "@tanstack/react-query";
import {
  createBrowserHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
  useParams,
} from "@tanstack/react-router";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { AdminSidebar } from "@/components/admin/admin-sidebar";
import { AppSidebar } from "@/components/app-sidebar/app-sidebar";
import { SidebarShell } from "@/components/layout/sidebar-shell";
import { TeamDetailPage } from "@/components/teams/team-page";
import { SidebarInset } from "@/components/ui/sidebar";
import { setCurrentOrganization } from "@/lib/organizations/current";
import { queryClient } from "@/query-client";
import { Route as AuditRoute } from "@/routes/_authed/admin/audit";
import { Route as ProvidersRoute } from "@/routes/_authed/admin/providers";
import { Route as AdminTeamsRoute } from "@/routes/_authed/admin/teams";

/**
 * A team's page with its Models row, Admin, AI providers with the teams that have a list of their
 * own, and Admin, Activity with a change to a team's models, as a page of their own for team-models-screens-layout.test.tsx to bundle and load in a
 * browser. They are the real screens in the app's real frames: Admin's sidebar and inset panel for
 * an admin, the app's for anybody else, as `routes/_authed/admin/route.tsx` and
 * `routes/_authed/_app.tsx` draw them. What the server answers comes from the test's routes.
 *
 * The page has no sign-in in front of it, so it starts in `default`, the organization those routes
 * answer for, as every test does (preload.ts, which a page loaded in a browser does not run).
 */
setCurrentOrganization("default");

const component = (route: { options: { component?: unknown } }) =>
  route.options.component as () => ReactNode;

function AdminTeamDetail() {
  const { teamId } = useParams({ strict: false }) as { teamId: string };
  return <TeamDetailPage key={teamId} shell="admin" teamId={teamId} />;
}

function TeamDetail() {
  const { teamId } = useParams({ strict: false }) as { teamId: string };
  return <TeamDetailPage key={teamId} teamId={teamId} />;
}

const rootRoute = createRootRoute({ component: () => <Outlet /> });

const adminRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "admin-frame",
  component: () => (
    <SidebarShell className="h-svh overflow-hidden">
      <AdminSidebar />
      <SidebarInset className="min-h-0 min-w-0 overflow-hidden">
        <Outlet />
      </SidebarInset>
    </SidebarShell>
  ),
});
const admin = (path: string, page: () => ReactNode) =>
  createRoute({ getParentRoute: () => adminRoute, path, component: page });

const appRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "app-frame",
  component: () => (
    <SidebarShell className="h-svh overflow-hidden">
      <AppSidebar />
      <SidebarInset className="min-h-0 overflow-hidden">
        <Outlet />
      </SidebarInset>
    </SidebarShell>
  ),
});

const router = createRouter({
  history: createBrowserHistory(),
  routeTree: rootRoute.addChildren([
    adminRoute.addChildren([
      admin("/admin/providers", component(ProvidersRoute)),
      // Admin's own Activity, with its recording controls under the log.
      admin("/admin/audit", component(AuditRoute)),
      admin("/admin/teams", component(AdminTeamsRoute)),
      admin("/admin/teams/$teamId", AdminTeamDetail),
    ]),
    appRoute.addChildren([
      createRoute({
        getParentRoute: () => appRoute,
        path: "/teams/$teamId",
        component: TeamDetail,
      }),
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
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
