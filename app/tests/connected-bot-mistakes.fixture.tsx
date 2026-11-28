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
import { GALLERY as ACTIVITY } from "@/components/gallery/activity";
import { GALLERY as CARDS } from "@/components/gallery/cards";
import { GALLERY as CHARTS } from "@/components/gallery/charts";
import { GALLERY as DECISIONS } from "@/components/gallery/decisions";
import { GALLERY as FORMS } from "@/components/gallery/form";
import { GALLERY as QUOTES } from "@/components/gallery/quote";
import { GALLERY as TABLES } from "@/components/gallery/table";
import { SidebarShell } from "@/components/layout/sidebar-shell";
import { SidebarInset } from "@/components/ui/sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  type AgentChannel,
  type ChannelPage,
  channelKeys,
} from "@/lib/channels/queries";
import { ActiveBotProvider } from "@/lib/copilot/active-bot";
import { GALLERY_COMPONENTS } from "@/lib/copilot/gallery-registry";
import { GalleryTools } from "@/lib/copilot/gallery-tools";
import { setCurrentOrganization } from "@/lib/organizations/current";
import { queryClient } from "@/query-client";

/**
 * A conversation with a connected Bot, as a page of its own for connected-bot-mistakes-layout.test.tsx
 * to bundle and load in a browser: the real conversation in the app's real frame, with the gallery
 * the app registers. What the server answers comes from the test's server.
 */
setCurrentOrganization("default");
// `import.meta.glob` is Vite's, so a bundle built without it finds no gallery modules.
if (GALLERY_COMPONENTS.length === 0)
  GALLERY_COMPONENTS.push(
    ...[
      ...ACTIVITY,
      ...CARDS,
      ...CHARTS,
      ...DECISIONS,
      ...FORMS,
      ...QUOTES,
      ...TABLES,
    ].sort((left, right) => left.name.localeCompare(right.name)),
  );

const CONVERSATION: AgentChannel = {
  id: "revenue-conversation",
  name: "Stock agent",
  agentIds: ["stock-agent"],
  threadId: "revenue-thread",
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
          summary: "Quarterly revenue",
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
        <ChannelChat channel={CONVERSATION} runtimeAgentId="stock-agent" />
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
        <ActiveBotProvider>
          <GalleryTools />
          <TooltipProvider>
            <RouterProvider router={router as never} />
          </TooltipProvider>
        </ActiveBotProvider>
      </CopilotKitProvider>
    </QueryClientProvider>,
  );
