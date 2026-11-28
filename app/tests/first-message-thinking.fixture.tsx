import { CopilotKitProvider } from "@copilotkit/react-core/v2";
import { QueryClientProvider } from "@tanstack/react-query";
import {
  createBrowserHistory,
  createRootRoute,
  createRouter,
  lazyRouteComponent,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { createRoot } from "react-dom/client";
import { SidebarShell } from "@/components/layout/sidebar-shell";
import { ThemeProvider } from "@/components/theme-provider";
import { SidebarInset } from "@/components/ui/sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";
import { type AuthenticatedUser, authKeys } from "@/lib/auth/queries";
import { setCurrentOrganization } from "@/lib/organizations/current";
import { queryClient } from "@/query-client";
import { Route as ConversationRoute } from "@/routes/_authed/_app/channel/$channelId";
import { Route as NewConversationRoute } from "@/routes/_authed/_app/channel/new";
import { Route as GroupRoute } from "@/routes/_authed/_app/group/$channelId";
import { Route as HomeRoute } from "@/routes/_authed/_app/index";
import { Route as StartRoute } from "@/routes/_authed/_app/start.$startId";

/**
 * The three places a first message is sent from, and the conversation it opens, for
 * first-message-thinking.test.tsx to bundle and load in a browser: home, the placeholder home opens
 * (`/start`), a new conversation (`/channel/new`) and the conversation itself (`/channel/...`, or
 * `/group/...` for a first message to two Bots), each the app's own route. What the server and the
 * Bot's run answer, and how long they take, comes from the test.
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
    <SidebarShell className="h-svh overflow-hidden">
      <SidebarInset className="min-h-0 overflow-hidden">
        <Outlet />
      </SidebarInset>
    </SidebarShell>
  ),
});

/** A file route of the app's, mounted at its own path under this root. */
function at<T extends { update: (options: never) => unknown }>(
  route: T,
  path: string,
  options: Record<string, unknown> = {},
) {
  return route.update({
    id: path,
    path,
    getParentRoute: () => rootRoute,
    ...options,
  } as never) as never;
}

/*
 * The placeholder's code arrives in a file of its own, as the app's build splits every route's
 * screen out (`autoCodeSplitting`, which wraps it the same way): fetched from the server the first
 * time it is wanted, and as slowly as the test's server sends it.
 */
const placeholder = StartRoute.options.component;
const placeholderChunk = lazyRouteComponent(
  () =>
    fetch("/chunks/start.js")
      .then((response) => response.text())
      .then(() => ({
        default: placeholder as NonNullable<typeof placeholder>,
      })),
  "default",
);

const router = createRouter({
  history: createBrowserHistory(),
  // Home reads the edition before it draws, through the router's query client, as the app's does.
  context: { queryClient },
  routeTree: rootRoute.addChildren([
    at(HomeRoute, "/"),
    at(StartRoute, "/start/$startId", { component: placeholderChunk }),
    at(NewConversationRoute, "/channel/new"),
    at(ConversationRoute, "/channel/$channelId"),
    at(GroupRoute, "/group/$channelId"),
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
