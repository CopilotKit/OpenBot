import { type InfiniteData, QueryClientProvider } from "@tanstack/react-query";
import {
  createBrowserHistory,
  createRootRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { createRoot } from "react-dom/client";
import { AppSidebar } from "@/components/app-sidebar/app-sidebar";
import { ConnectionBanner } from "@/components/layout/connection-banner";
import { SidebarShell } from "@/components/layout/sidebar-shell";
import { SidebarInset } from "@/components/ui/sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";
import { type ChannelPage, channelKeys } from "@/lib/channels/queries";
import { setCurrentOrganization } from "@/lib/organizations/current";
import { queryClient } from "@/query-client";
import { Route as ChannelRoute } from "@/routes/_authed/_app/channel/$channelId";

/**
 * A conversation opened inside OpenBot Desktop while the OpenBot it is connected to can't be
 * reached, as a page of its own for offline-conversation-layout.test.tsx to bundle and load in a
 * browser: the app's real frame (its sidebar, the connection line and the inset panel, as
 * `routes/_authed/_app.tsx` draws them) around the conversation's real route. The desktop app
 * stands in at `window.__TAURI_INTERNALS__`, connected; every request gets the relay's answer for
 * an OpenBot that does not answer, from the test's routes.
 *
 * The sidebar's list is the one the app held from before OpenBot stopped answering.
 */
(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
  invoke: async (command: string) => {
    if (command === "plugin:openbot-desktop|connection")
      return { mode: "connected", address: "https://openbot.example.com" };
    throw `command ${command} not found`;
  },
  transformCallback: () => 0,
};
setCurrentOrganization("default");

queryClient.setQueryDefaults(channelKeys.list(), { staleTime: Infinity });
queryClient.setQueryData<InfiniteData<ChannelPage>>(channelKeys.list(), {
  pages: [
    {
      channels: [
        {
          id: "away-conversation",
          name: "Release Bot",
          agentIds: ["release-bot"],
          threadId: "away-thread",
          active: true,
          lastMessageAt: "2026-11-15T09:20:00.000Z",
          summary: "Overnight changes to the release branch",
          lastMessage: "Two pull requests merged.",
          lastMessageAgentId: "release-bot",
          createdAt: "2026-11-15T09:19:00.000Z",
          pinned: false,
          lastReadAt: "2026-11-15T09:20:00.000Z",
        },
      ],
      nextCursor: null,
    },
  ],
  pageParams: [""],
});

const rootRoute = createRootRoute({
  component: () => (
    <SidebarShell className="h-svh overflow-hidden">
      <AppSidebar />
      <SidebarInset className="min-h-0 overflow-hidden">
        <ConnectionBanner />
        <Outlet />
      </SidebarInset>
    </SidebarShell>
  ),
});
/*
 * TanStack's generated tree wires a file route with update({ id, path, getParentRoute })
 * (app/src/routeTree.gen.ts); the update type leaves those fields out, hence the cast.
 */
const conversationRoute = ChannelRoute.update({
  id: "/channel/$channelId",
  path: "/channel/$channelId",
  getParentRoute: () => rootRoute,
} as Parameters<typeof ChannelRoute.update>[0] & {
  id: string;
  path: string;
  getParentRoute: () => typeof rootRoute;
});
const router = createRouter({
  history: createBrowserHistory(),
  routeTree: rootRoute.addChildren([conversationRoute]),
});

const root = document.getElementById("root");
if (root)
  createRoot(root).render(
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <RouterProvider router={router as never} />
      </TooltipProvider>
    </QueryClientProvider>,
  );
