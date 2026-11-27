import { CopilotKitProvider } from "@copilotkit/react-core/v2";
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
import { SidebarShell } from "@/components/layout/sidebar-shell";
import { ThemeProvider } from "@/components/theme-provider";
import { SidebarInset } from "@/components/ui/sidebar";
import {
  currentUserQueryOptions,
  type AuthenticatedUser,
} from "@/lib/auth/queries";
import {
  type DeploymentCapabilities,
  deploymentCapabilitiesQueryOptions,
} from "@/lib/deployment/queries";
import { setCurrentOrganization } from "@/lib/organizations/current";
import { queryClient } from "@/query-client";
import { Route as HomeRoute } from "@/routes/_authed/_app/index";

/**
 * The home screen, for home-holds-still.test.tsx to bundle and load in a browser: the app's own
 * route and composer, drawn the way the app draws them once the gate has read who is signed in and
 * which edition this is (`?edition=personal` or `?edition=business`). The Bots list and the
 * conversation list are NOT here: they are requests the test answers after a pause, as a server
 * does, so the page is seen while they are on their way.
 *
 * Started in `default`, the organization those routes answer for, as every test does.
 */
setCurrentOrganization("default");

const edition =
  new URLSearchParams(location.search).get("edition") === "personal"
    ? "personal"
    : "team";
queryClient.setQueryData(deploymentCapabilitiesQueryOptions().queryKey, {
  generativeUi: true,
  selfHostBanner: false,
  localEvaluation: false,
  edition,
} satisfies DeploymentCapabilities);
queryClient.setQueryData(currentUserQueryOptions().queryKey, {
  id: "person",
  email: "sam@example.com",
  name: "Sam Rivera",
  role: "admin",
  onboarding: null,
  openbotVersion: "v1.0.2",
} as AuthenticatedUser);

/** The app's frame around the page, as `_app` draws it, without the sidebar's own lists. */
const rootRoute = createRootRoute({
  component: () => (
    <SidebarShell className="h-svh overflow-hidden">
      <SidebarInset className="min-h-0 overflow-hidden">
        <Outlet />
      </SidebarInset>
    </SidebarShell>
  ),
});
const router = createRouter({
  history: createBrowserHistory(),
  routeTree: rootRoute.addChildren([
    createRoute({
      getParentRoute: () => rootRoute,
      path: "/",
      validateSearch: HomeRoute.options.validateSearch,
      component: HomeRoute.options.component,
    }),
    createRoute({
      getParentRoute: () => rootRoute,
      path: "/start/$startId",
      component: () => <p data-app-starting="">Starting</p>,
    }),
  ]),
});

const root = document.getElementById("root");
if (root)
  createRoot(root).render(
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <CopilotKitProvider runtimeUrl="/api/copilotkit">
          <RouterProvider router={router as never} />
        </CopilotKitProvider>
      </ThemeProvider>
    </QueryClientProvider>,
  );
