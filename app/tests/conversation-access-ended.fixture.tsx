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
import { setCurrentOrganization } from "@/lib/organizations/current";
import { queryClient } from "@/query-client";

/**
 * A conversation with a Bot, as a page of its own for conversation-access-ended.test.tsx to bundle
 * and load in a browser: the real conversation in the app's real frame (its sidebar and inset
 * panel, as `routes/_authed/_app.tsx` draws them), with the runtime client the app uses. What the
 * server answers comes from the test's routes.
 *
 * The conversation's row is put in the roster here and kept, so the page asks the test's server
 * only for what the conversation itself reads. The route's header above the conversation (the
 * Bot's name and the two buttons) is not drawn.
 */
setCurrentOrganization("default");

const CONVERSATION: AgentChannel = {
  id: "pipeline-conversation",
  name: "Pipeline Bot",
  agentIds: ["pipeline-bot"],
  threadId: "pipeline-thread",
  active: true,
  lastMessageAt: "2026-11-15T09:20:00.000Z",
};

queryClient.setQueryDefaults(channelKeys.list(), { staleTime: Infinity });
queryClient.setQueryData<InfiniteData<ChannelPage>>(channelKeys.list(), {
  pages: [
    {
      channels: [
        {
          ...CONVERSATION,
          summary: "586 Plus 637 Calculation",
          lastMessage: "1223",
          lastMessageAgentId: "pipeline-bot",
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
        <ChannelChat channel={CONVERSATION} runtimeAgentId="pipeline-bot" />
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
