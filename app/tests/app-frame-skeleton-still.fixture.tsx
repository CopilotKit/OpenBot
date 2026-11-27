import { CopilotKitProvider } from "@copilotkit/react-core/v2";
import { QueryClientProvider } from "@tanstack/react-query";
import {
  type AnyRoute,
  createBrowserHistory,
  createRootRouteWithContext,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { createRoot } from "react-dom/client";
import { ThemeProvider } from "@/components/theme-provider";
import { setCurrentOrganization } from "@/lib/organizations/current";
import { queryClient } from "@/query-client";
import type { RouterContext } from "@/router-context";
import { Route as AuthedRoute } from "@/routes/_authed";
import { Route as AppRoute } from "@/routes/_authed/_app";

/**
 * The app's frame as a returning person first sees it, for app-frame-skeleton-still.test.tsx to
 * bundle and load in a browser: the real sign-in gate (`_authed`'s `beforeLoad` and its pending
 * frame) in front of the real `_app` frame, around a stub page. The gate's own component is a bare
 * outlet, so the only frames in the document are the skeleton and then `_app`'s. Whether somebody
 * was signed in, and whether the panel was left open, are in the browser's storage before this
 * runs; what the server answers comes from the test's routes.
 *
 * Started in `default`, the organization those routes answer for, as every test does.
 */
setCurrentOrganization("default");

const root = createRootRouteWithContext<RouterContext>()({ component: Outlet });
const gate = AuthedRoute.options as unknown as Record<string, unknown>;
const authed = createRoute({
  id: "_authed",
  getParentRoute: () => root,
  component: Outlet,
  ...{
    beforeLoad: gate.beforeLoad,
    pendingComponent: gate.pendingComponent,
    pendingMs: gate.pendingMs,
    pendingMinMs: gate.pendingMinMs,
  },
} as never) as unknown as AnyRoute;
const app = createRoute({
  id: "_app",
  getParentRoute: () => authed,
  component: AppRoute.options.component,
} as never) as unknown as AnyRoute;
const page = createRoute({
  getParentRoute: () => app,
  path: "/",
  component: () => <p data-stub-page="">The page</p>,
} as never) as unknown as AnyRoute;

// Any other address the test opens (a section with no panel, such as /routines) is the same stub page.
const other = createRoute({
  getParentRoute: () => app,
  path: "$",
  component: () => <p data-stub-page="">The page</p>,
} as never) as unknown as AnyRoute;

const router = createRouter({
  history: createBrowserHistory(),
  routeTree: root.addChildren([
    authed.addChildren([app.addChildren([page, other])]),
  ]),
  context: { queryClient },
});

const mount = document.getElementById("root");
if (mount)
  createRoot(mount).render(
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <CopilotKitProvider runtimeUrl="/api/copilotkit">
          <RouterProvider router={router as never} />
        </CopilotKitProvider>
      </ThemeProvider>
    </QueryClientProvider>,
  );
