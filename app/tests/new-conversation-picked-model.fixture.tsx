import { CopilotKitProvider } from "@copilotkit/react-core/v2";
import { QueryClientProvider } from "@tanstack/react-query";
import {
  createBrowserHistory,
  createRootRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { createRoot } from "react-dom/client";
import { SidebarShell } from "@/components/layout/sidebar-shell";
import { ThemeProvider } from "@/components/theme-provider";
import { SidebarInset } from "@/components/ui/sidebar";
import { Toaster } from "@/components/ui/toast";
import { TooltipProvider } from "@/components/ui/tooltip";
import { type AuthenticatedUser, authKeys } from "@/lib/auth/queries";
import { setCurrentOrganization } from "@/lib/organizations/current";
import { queryClient } from "@/query-client";
import { Route as ConversationRoute } from "@/routes/_authed/_app/channel/$channelId";
import { Route as NewConversationRoute } from "@/routes/_authed/_app/channel/new";

/**
 * A new conversation (`/channel/new`) and the conversation its first message opens, each the app's
 * own route, for new-conversation-picked-model.test.tsx to bundle and load in a browser. The toasts
 * are drawn beside them, as the app's root draws them. What the server answers comes from the test.
 *
 * The signed-in person is put in place here, as the signed-in gate leaves them.
 */
setCurrentOrganization("default");
queryClient.setQueryDefaults(authKeys.currentUser(), { staleTime: Infinity });
queryClient.setQueryData(authKeys.currentUser(), {
  id: "dana",
  name: "Dana Reyes",
  email: "dana.reyes@northwind.example",
} as AuthenticatedUser);

/** The app's frame around the page, as `_app` draws it, without the sidebar's own lists. */
const rootRoute = createRootRoute({
  component: () => (
    <>
      <SidebarShell className="h-svh overflow-hidden">
        <SidebarInset className="min-h-0 overflow-hidden">
          <Outlet />
        </SidebarInset>
      </SidebarShell>
      <Toaster />
    </>
  ),
});

/** A file route of the app's, mounted at its own path under this root. */
function at<T extends { update: (options: never) => unknown }>(
  route: T,
  path: string,
) {
  return route.update({
    id: path,
    path,
    getParentRoute: () => rootRoute,
  } as never) as never;
}

const router = createRouter({
  history: createBrowserHistory(),
  context: { queryClient },
  routeTree: rootRoute.addChildren([
    at(NewConversationRoute, "/channel/new"),
    at(ConversationRoute, "/channel/$channelId"),
  ]),
});

const root = document.getElementById("root");
if (root)
  createRoot(root).render(
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <CopilotKitProvider credentials="include" runtimeUrl="/api/copilotkit">
          <TooltipProvider>
            <RouterProvider router={router as never} />
          </TooltipProvider>
        </CopilotKitProvider>
      </ThemeProvider>
    </QueryClientProvider>,
  );
