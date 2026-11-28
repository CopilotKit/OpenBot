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
import { PageShell } from "@/components/layout/page-shell";
import { OrganizationBoundary } from "@/components/organizations/organization-boundary";
import { SkillsSettingsPage } from "@/components/skills/skills-settings-page";
import { ThemeProvider } from "@/components/theme-provider";
import { TooltipProvider } from "@/components/ui/tooltip";
import { BotListScopeProvider } from "@/lib/agents/list-scope";
import { signedInUser } from "@/lib/auth/queries";
import { ReportedErrorComponent } from "@/lib/error-reporting";
import { queryClient } from "@/query-client";
import { Route as AppRoute } from "@/routes/_authed/_app";
import { Route as ApprovalsRoute } from "@/routes/_authed/admin/approvals";
import { Route as ComputersRoute } from "@/routes/_authed/admin/computers";
import { Route as LearningRoute } from "@/routes/_authed/admin/learning";
import { Route as PlaygroundRoute } from "@/routes/_authed/admin/playground";
import { Route as ProactiveRoute } from "@/routes/_authed/admin/proactive";
import { Route as SettingsApprovalsRoute } from "@/routes/_authed/settings/approvals";
import { Route as NotificationsRoute } from "@/routes/_authed/settings/notifications";
import { Route as SetupRoute } from "@/routes/_authed/settings/setup";

/**
 * The app as organization-unavailable-admin-pages.test.tsx loads it in a browser: the signed-in
 * gate's first step, the organization boundary, and the app's real frame, as
 * organization-notices.fixture.tsx has them. Inside it, a stand-in home and the real pages the
 * end-to-end test of database sharding found mishandling an outage: Admin's Computers, Playground,
 * Automatic learning and Approvals, Settings' Setup, and Skills; and pages a sweep after it found
 * the same way: Admin's Routines, and Settings' Approvals and Notifications. Admin's pages list every Bot in the
 * organization, as Admin's frame has them (lib/agents/list-scope.tsx).
 */
const rootRoute = createRootRoute({
  beforeLoad: () => signedInUser(queryClient),
  component: () => (
    <OrganizationBoundary>
      <Outlet />
    </OrganizationBoundary>
  ),
});

const appRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "app",
  component: AppRoute.options.component as () => ReactNode,
});

const homeRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/",
  component: () => (
    <PageShell title="Home">
      <p>Start a conversation.</p>
    </PageShell>
  ),
});

/** A page of Admin's, at `path`, with every Bot in the organization in its lists. */
function adminRoute(path: string, page: unknown) {
  const Page = page as () => ReactNode;
  return createRoute({
    getParentRoute: () => appRoute,
    path,
    component: () => (
      <BotListScopeProvider scope="organization">
        <Page />
      </BotListScopeProvider>
    ),
  });
}

const router = createRouter({
  history: createBrowserHistory(),
  defaultErrorComponent: ReportedErrorComponent,
  routeTree: rootRoute.addChildren([
    appRoute.addChildren([
      homeRoute,
      adminRoute("/admin/computers", ComputersRoute.options.component),
      adminRoute("/admin/playground", PlaygroundRoute.options.component),
      adminRoute("/admin/learning", LearningRoute.options.component),
      adminRoute("/admin/approvals", ApprovalsRoute.options.component),
      adminRoute("/admin/proactive", ProactiveRoute.options.component),
      createRoute({
        getParentRoute: () => appRoute,
        path: "/settings/setup",
        component: SetupRoute.options.component as () => ReactNode,
      }),
      createRoute({
        getParentRoute: () => appRoute,
        path: "/settings/approvals",
        component: SettingsApprovalsRoute.options.component as () => ReactNode,
      }),
      createRoute({
        getParentRoute: () => appRoute,
        path: "/settings/notifications",
        component: NotificationsRoute.options.component as () => ReactNode,
      }),
      createRoute({
        getParentRoute: () => appRoute,
        path: "/skills",
        component: () => <SkillsSettingsPage creating={false} />,
      }),
    ]),
  ]),
});

(window as unknown as { openbotRouter: unknown }).openbotRouter = router;

const root = document.getElementById("root");
if (root)
  createRoot(root).render(
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <TooltipProvider>
          <RouterProvider router={router as never} />
        </TooltipProvider>
      </ThemeProvider>
    </QueryClientProvider>,
  );
