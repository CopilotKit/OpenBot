import { QueryClientProvider } from "@tanstack/react-query";
import {
  createBrowserHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Link,
  lazyRouteComponent,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { lazy, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { SidebarShell } from "@/components/layout/sidebar-shell";
import { ThemeProvider } from "@/components/theme-provider";
import { SidebarInset } from "@/components/ui/sidebar";
import { ReportedErrorComponent } from "@/lib/error-reporting";
import { queryClient } from "@/query-client";

/**
 * The app's error screen around parts of the app fetched as files of their own, for
 * chunk-recovery.test.tsx to bundle with code splitting and load in a browser.
 *
 * Two kinds of lazily loaded code, as the app has them: a route's component, through TanStack
 * Router's `lazyRouteComponent` (what the router plugin's code splitting writes for every route),
 * and a part of a page through React's `lazy` (how Streamdown loads its code block). Each is a file
 * the test's server can stop serving, as an OpenBot does once a release replaced the build.
 *
 * The router's error screen is the app's own (`ReportedErrorComponent`), as `router.tsx` sets it.
 */
const LazyPart = lazy(() => import("./chunk-recovery-part.fixture"));

const rootRoute = createRootRoute({
  component: () => (
    <SidebarShell className="h-svh overflow-hidden">
      <nav
        aria-label="Conversations"
        className="flex w-64 shrink-0 flex-col gap-2 p-4 text-sm"
      >
        {/* This router's own paths, which the app's registered route types don't know. */}
        <Link to="/">Home</Link>
        <Link to={"/part" as "/"}>Part</Link>
        <Link to={"/route-a" as "/"}>Route A</Link>
        <Link to={"/route-b" as "/"}>Route B</Link>
      </nav>
      <SidebarInset className="min-h-0 overflow-hidden">
        <Outlet />
      </SidebarInset>
    </SidebarShell>
  ),
});

const router = createRouter({
  history: createBrowserHistory(),
  defaultErrorComponent: ReportedErrorComponent,
  routeTree: rootRoute.addChildren([
    createRoute({
      getParentRoute: () => rootRoute,
      path: "/",
      component: () => <p data-home="">Home</p>,
    }),
    createRoute({
      getParentRoute: () => rootRoute,
      path: "/part",
      component: () => (
        <Suspense fallback={null}>
          <LazyPart />
        </Suspense>
      ),
    }),
    createRoute({
      getParentRoute: () => rootRoute,
      path: "/route-a",
      component: lazyRouteComponent(
        () => import("./chunk-recovery-route-a.fixture"),
        "RouteA",
      ),
    }),
    createRoute({
      getParentRoute: () => rootRoute,
      path: "/route-b",
      component: lazyRouteComponent(
        () => import("./chunk-recovery-route-b.fixture"),
        "RouteB",
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
