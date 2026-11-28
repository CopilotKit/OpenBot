import { CopilotKitProvider } from "@copilotkit/react-core/v2";
import { type InfiniteData, QueryClientProvider } from "@tanstack/react-query";
import {
  createBrowserHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { createRoot } from "react-dom/client";
import { AppSidebar } from "@/components/app-sidebar/app-sidebar";
import { ChannelChat } from "@/components/channels/channel-chat";
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
import { quietRunPeriod } from "@/lib/copilot/quiet-run";
import { setCurrentOrganization } from "@/lib/organizations/current";
import { queryClient } from "@/query-client";

/**
 * A conversation with a Bot, as a page of its own for run-ended-unheard-layout.test.tsx to bundle and
 * load in a browser: the real conversation in the app's real frame (its sidebar and inset panel, as
 * `routes/_authed/_app.tsx` draws them), with the runtime client the app uses. What the server
 * answers comes from the test's server.
 *
 * The quiet period is the test's (`?quietMs=`): nothing in a browser check can wait out the
 * three quarters of a minute the app waits before it asks the server about a quiet run.
 */
setCurrentOrganization("default");
quietRunPeriod.ms = Number(
  new URLSearchParams(location.search).get("quietMs") ?? quietRunPeriod.ms,
);

const CONVERSATION: AgentChannel = {
  id: "launch-conversation",
  name: "General Assistant",
  agentIds: ["general-assistant"],
  threadId: "launch-thread",
  active: true,
  lastMessageAt: "2026-11-25T18:00:00.000Z",
};

queryClient.setQueryDefaults(channelKeys.list(), { staleTime: Infinity });
queryClient.setQueryData<InfiniteData<ChannelPage>>(channelKeys.list(), {
  pages: [
    {
      channels: [
        {
          ...CONVERSATION,
          summary: "Launch plan",
          lastMessage: null,
          lastMessageAgentId: null,
          createdAt: "2026-11-25T18:00:00.000Z",
          pinned: false,
          lastReadAt: "2026-11-25T18:00:00.000Z",
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
        {/* The computer's tools, as the app's provider registers them: a Bot's command runs here. */}
        <ActiveBotProvider>
          <BotOffers />
          <ComputerTools />
          <ChannelChat
            channel={CONVERSATION}
            runtimeAgentId="general-assistant"
          />
        </ActiveBotProvider>
      </SidebarInset>
    </SidebarShell>
  ),
});
const router = createRouter({
  history: createBrowserHistory(),
  routeTree: rootRoute.addChildren([
    createRoute({
      getParentRoute: () => rootRoute,
      path: "$",
      component: () => null,
    }),
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
