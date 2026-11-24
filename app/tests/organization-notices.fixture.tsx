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
import { ThemeProvider } from "@/components/theme-provider";
import { TooltipProvider } from "@/components/ui/tooltip";
import { signedInUser } from "@/lib/auth/queries";
import { ReportedErrorComponent } from "@/lib/error-reporting";
import { queryClient } from "@/query-client";
import { Route as AppRoute } from "@/routes/_authed/_app";
import { Route as RoutinesRoute } from "@/routes/_authed/_app/routines";

/**
 * The app as organization-moving.test.tsx, organization-removed.test.tsx and
 * organization-held-reload.test.tsx load it in a browser:
 * the signed-in gate's first step (who is signed in, and the organization they work in), the
 * organization boundary `_authed` puts around everything, and the app's real frame (`_authed/_app`:
 * the strip, its panels and every bar over the page). Inside it, Routines is the real page; home is
 * a stand-in heading. OpenBot's API is the test's routes.
 *
 * `window.openbotRouter` lets the test move between pages as a link does, at any window width.
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

const routinesRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/routines",
  component: RoutinesRoute.options.component as () => ReactNode,
});

const router = createRouter({
  history: createBrowserHistory(),
  // The app's own error boundary, as router.tsx gives every route.
  defaultErrorComponent: ReportedErrorComponent,
  routeTree: rootRoute.addChildren([
    appRoute.addChildren([homeRoute, routinesRoute]),
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
