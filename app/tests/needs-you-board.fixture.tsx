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
import { AppSidebar } from "@/components/app-sidebar/app-sidebar";
import { BotRoster } from "@/components/bots/bot-roster";
import { PageShell } from "@/components/layout/page-shell";
import { SidebarShell } from "@/components/layout/sidebar-shell";
import { BotNeedsYou } from "@/components/needs-you/board";
import { SidebarInset } from "@/components/ui/sidebar";
import { setCurrentOrganization } from "@/lib/organizations/current";
import { queryClient } from "@/query-client";

/**
 * The Needs you board, as a page of its own for needs-you-board-layout.test.tsx to bundle and load in
 * a browser: the Bots page and a Bot's page, the real components in the app's real frame (its sidebar
 * and inset panel, as `routes/_authed/_app.tsx` draws them). What the server answers comes from the
 * test's routes.
 *
 * The page has no sign-in in front of it, so it starts in `default`, the organization those routes
 * answer for, as every test does (preload.ts, which a page loaded in a browser does not run).
 */
setCurrentOrganization("default");

const rootRoute = createRootRoute({ component: () => <Outlet /> });

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
    appRoute.addChildren([
      app("/bots", () => (
        <PageShell description="Your Bots for everyday work." title="Bots">
          <BotRoster />
        </PageShell>
      )),
      app("/bots/$agentId", () => (
        <PageShell title="Inbox Bot">
          <BotNeedsYou agentId="inbox" />
        </PageShell>
      )),
      app("/bots/$agentId/activity", () => null),
      app("/channel/$channelId", () => null),
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
