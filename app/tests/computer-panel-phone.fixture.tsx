import { CopilotKitProvider } from "@copilotkit/react-core/v2";
import { type InfiniteData, QueryClientProvider } from "@tanstack/react-query";
import {
  createBrowserHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { createRoot } from "react-dom/client";
import { AppSidebar } from "@/components/app-sidebar/app-sidebar";
import { SidebarShell } from "@/components/layout/sidebar-shell";
import { SidebarInset } from "@/components/ui/sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  type AgentChannel,
  type ChannelPage,
  channelKeys,
} from "@/lib/channels/queries";
import { ActiveBotProvider } from "@/lib/copilot/active-bot";
import { BotOffers } from "@/lib/copilot/bot-offer";
import { ComputerTools } from "@/lib/copilot/computer-tools";
import { setCurrentOrganization } from "@/lib/organizations/current";
import { queryClient } from "@/query-client";
import { Route as ChannelRoute } from "@/routes/_authed/_app/channel/$channelId";

/**
 * A conversation with a Bot as its route draws it, for computer-panel-phone-layout.test.tsx to
 * bundle and load in a browser: the app's frame (its sidebar and inset panel), the conversation's
 * own route with its header, its Computer and the pane they share, and the computer tools the app's
 * provider registers. What the server, the runtime and the Bot's computer answer comes from the test.
 */
setCurrentOrganization("default");

const CONVERSATION: AgentChannel = {
  id: "garden-conversation",
  name: "Fernhill Member",
  agentIds: ["fernhill-member"],
  threadId: "garden-thread",
  active: true,
  lastMessageAt: "2026-11-26T18:00:00.000Z",
};

queryClient.setQueryDefaults(channelKeys.list(), { staleTime: Infinity });
queryClient.setQueryDefaults(channelKeys.detail(CONVERSATION.id), {
  staleTime: Infinity,
});
queryClient.setQueryData(channelKeys.detail(CONVERSATION.id), CONVERSATION);
queryClient.setQueryData<InfiniteData<ChannelPage>>(channelKeys.list(), {
  pages: [
    {
      channels: [
        {
          ...CONVERSATION,
          summary: "Seed allowance",
          lastMessage: null,
          lastMessageAgentId: null,
          createdAt: "2026-11-26T18:00:00.000Z",
          pinned: false,
          lastReadAt: "2026-11-26T18:00:00.000Z",
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
        {/* The computer's tools, as the app's provider registers them: a Bot's request runs here. */}
        <ActiveBotProvider>
          <BotOffers />
          <ComputerTools />
          <Outlet />
        </ActiveBotProvider>
      </SidebarInset>
    </SidebarShell>
  ),
});

/*
 * TanStack's generated tree wires a file route with update({ id, path, getParentRoute })
 * (app/src/routeTree.gen.ts); the update type leaves those fields out, hence the cast.
 */
const authedRoute = createRoute({
  id: "/_authed",
  getParentRoute: () => rootRoute,
  component: Outlet,
});
const appRoute = createRoute({
  id: "/_app",
  getParentRoute: () => authedRoute,
  component: Outlet,
});
const conversationRoute = ChannelRoute.update({
  id: "/channel/$channelId",
  path: "/channel/$channelId",
  getParentRoute: () => appRoute,
} as Parameters<typeof ChannelRoute.update>[0] & {
  id: string;
  path: string;
  getParentRoute: () => typeof appRoute;
});

const router = createRouter({
  history: createBrowserHistory(),
  routeTree: rootRoute.addChildren([
    authedRoute.addChildren([appRoute.addChildren([conversationRoute])]),
  ]),
});

const root = document.getElementById("root");
if (root)
  createRoot(root).render(
    <QueryClientProvider client={queryClient}>
      <CopilotKitProvider credentials="include" runtimeUrl="/api/copilotkit">
        <TooltipProvider>
          <RouterProvider router={router as never} />
        </TooltipProvider>
      </CopilotKitProvider>
    </QueryClientProvider>,
  );
