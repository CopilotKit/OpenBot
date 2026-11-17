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
import { BotSubpage } from "@/components/bot-profile/bot-subpage";
import { SharingSections } from "@/components/bot-profile/sharing";
import { SidebarShell } from "@/components/layout/sidebar-shell";
import { SkillsSettingsPage } from "@/components/skills/skills-settings-page";
import { NewTeamPage } from "@/components/teams/new-team-page";
import { TeamDetailPage } from "@/components/teams/team-page";
import { TeamsPage } from "@/components/teams/teams-page";
import { SidebarInset } from "@/components/ui/sidebar";
import { setCurrentOrganization } from "@/lib/organizations/current";
import { Route as AdminOverviewRoute } from "@/routes/_authed/admin/index";
import { Route as PeopleRoute } from "@/routes/_authed/admin/people";
import { queryClient } from "@/query-client";

/**
 * The team screens and a Bot's Sharing page, as a page of their own for
 * teams-screens-layout.test.tsx to bundle and load in a browser. The team screens are the real
 * ones in the app's real frame (its sidebar and inset panel, as `routes/_authed/_app.tsx` draws
 * them), at their own addresses, beside a page that was there before (Skills) to compare them
 * with. Admin's frame holds the overview, which lists Teams, and People. What the server answers
 * comes from the test's routes.
 *
 * The page has no sign-in in front of it, so it starts in `default`, the organization those routes
 * answer for, as every test does (preload.ts, which a page loaded in a browser does not run).
 */
setCurrentOrganization("default");

const component = (route: { options: { component?: unknown } }) =>
  route.options.component as () => ReactNode;

function TeamDetail() {
  const { teamId } = useParams({ strict: false }) as { teamId: string };
  return <TeamDetailPage key={teamId} teamId={teamId} />;
}

function Sharing() {
  const { agentId } = useParams({ strict: false }) as { agentId: string };
  return (
    <BotSubpage
      agentId={agentId}
      description="Choose who can use this Bot. Each person’s conversations with it are private."
      title="Sharing"
    >
      {(agent) => <SharingSections agent={agent} />}
    </BotSubpage>
  );
}

const rootRoute = createRootRoute({ component: () => <Outlet /> });

/** Admin's frame: the same sidebar and inset panel as the app's own Admin layout. */
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

/** The app's frame: the same sidebar and inset panel as `routes/_authed/_app.tsx`. */
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
const app = (path: string, page: () => ReactNode) =>
  createRoute({ getParentRoute: () => appRoute, path, component: page });

const router = createRouter({
  history: createBrowserHistory(),
  routeTree: rootRoute.addChildren([
    adminRoute.addChildren([
      admin("/admin", component(AdminOverviewRoute)),
      admin("/admin/people", component(PeopleRoute)),
    ]),
    appRoute.addChildren([
      app("/teams", TeamsPage),
      app("/teams/new", NewTeamPage),
      app("/teams/$teamId", TeamDetail),
      app("/skills", () => (
        <SkillsSettingsPage creating={false} editing={undefined} />
      )),
    ]),
    // A Bot's page is in the app's frame, whose sidebar is not this test's business.
    createRoute({
      getParentRoute: () => rootRoute,
      path: "/bots/$agentId/sharing",
      component: () => (
        <div className="flex h-svh flex-col overflow-hidden bg-background">
          <Sharing />
        </div>
      ),
    }),
    createRoute({
      getParentRoute: () => rootRoute,
      path: "/bots/$agentId",
      component: () => null,
    }),
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
