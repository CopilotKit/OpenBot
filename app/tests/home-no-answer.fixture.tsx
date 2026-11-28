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
import { type AgentProfile, agentKeys } from "@/lib/agents/queries";
import { setCurrentOrganization } from "@/lib/organizations/current";
import { queryClient } from "@/query-client";
import { Route as HomeRoute } from "@/routes/_authed/_app/index";

/**
 * The home screen, for home-no-answer.test.tsx to bundle and load in a browser: the app's own route,
 * its composer and the start sequence behind it. The conversation a message opens is a placeholder
 * that says so: this is about what home says when the start fails. What the server answers comes
 * from the test's routes.
 *
 * Started in `default`, the organization those routes answer for, as every test does.
 */
setCurrentOrganization("default");

const bot: AgentProfile = {
  assignedToMe: false,
  keyFromOpenBot: false,
  avatarSeed: "seed",
  builtIn: true,
  canManage: true,
  endpoint: null,
  hasAuth: false,
  hasCallbackToken: false,
  isolated: false,
  isolationActive: false,
  isolationOffReason: null,
  hidden: false,
  pinned: false,
  mine: true,
  name: "Terra Bot",
  roleDescription: "Answers on OpenBot's model.",
  systemOwned: false,
  title: "Analyst",
  visibility: "public",
  id: "terra-bot",
  runsOnOpenBotModel: true,
};
queryClient.setQueryData(agentKeys.list(false), [bot]);

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
