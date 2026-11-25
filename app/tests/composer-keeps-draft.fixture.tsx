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
import { ChannelChat } from "@/components/channels/channel-chat";
import { Composer } from "@/components/channels/composer/composer";
import { SidebarShell } from "@/components/layout/sidebar-shell";
import { SidebarInset } from "@/components/ui/sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";
import { type AuthenticatedUser, authKeys } from "@/lib/auth/queries";
import {
  type AgentChannel,
  type ChannelPage,
  channelKeys,
} from "@/lib/channels/queries";
import { setCurrentOrganization } from "@/lib/organizations/current";
import { queryClient } from "@/query-client";

/**
 * Two conversations in the app's frame, for composer-keeps-draft-browser.test.tsx to bundle and
 * load in a browser: the real sidebar, which a person switches between them with, and each
 * conversation as its route draws it, keyed on its id so leaving one unmounts it and its composer.
 * What the server and the gateway answer comes from the test.
 *
 * The roster and the signed-in person are put in place here, as the signed-in gate leaves them.
 */
setCurrentOrganization("default");
queryClient.setQueryDefaults(authKeys.currentUser(), { staleTime: Infinity });
queryClient.setQueryData(authKeys.currentUser(), {
  id: "dana",
  name: "Dana Reyes",
  email: "dana.reyes@northwind.example",
} as AuthenticatedUser);

const DESIGN: AgentChannel = {
  id: "design-conversation",
  name: "Design Bot",
  agentIds: ["design-bot"],
  threadId: "design-thread",
  active: true,
  lastMessageAt: "2026-11-23T21:00:00.000Z",
};

const NOTES: AgentChannel = {
  id: "notes-conversation",
  name: "Notes Bot",
  agentIds: ["notes-bot"],
  threadId: "notes-thread",
  active: true,
  lastMessageAt: "2026-11-23T20:00:00.000Z",
};

const CONVERSATIONS = [DESIGN, NOTES];

queryClient.setQueryDefaults(channelKeys.list(), { staleTime: Infinity });
queryClient.setQueryData<InfiniteData<ChannelPage>>(channelKeys.list(), {
  pages: [
    {
      channels: [
        {
          ...DESIGN,
          summary: "Three landing page directions",
          lastMessage: "Three directions for the landing page",
          lastMessageAgentId: "design-bot",
          createdAt: "2026-11-23T20:59:00.000Z",
          pinned: false,
          lastReadAt: "2026-11-23T21:00:00.000Z",
        },
        {
          ...NOTES,
          summary: "Meeting notes",
          lastMessage: "Here are the notes.",
          lastMessageAgentId: "notes-bot",
          createdAt: "2026-11-23T19:59:00.000Z",
          pinned: false,
          lastReadAt: "2026-11-23T20:00:00.000Z",
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
        <Outlet />
      </SidebarInset>
    </SidebarShell>
  ),
});

/** One conversation, as `routes/_authed/_app/channel/$channelId.tsx` draws its body. */
function Conversation({ channelId }: { channelId: string }) {
  const channel = CONVERSATIONS.find((one) => one.id === channelId);
  if (!channel) return null;
  return (
    <ChannelChat
      channel={channel}
      key={channel.id}
      runtimeAgentId={channel.agentIds[0]}
    />
  );
}

const conversationRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "channel/$channelId",
  component: function ConversationRoute() {
    const { channelId } = conversationRoute.useParams();
    return <Conversation channelId={channelId} />;
  },
});

/** The box a screen with no conversation yet draws (home), which holds its files in this tab. */
const homeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "home",
  component: () => (
    <div className="flex flex-1 items-center justify-center p-4">
      <Composer
        className="w-full max-w-2xl"
        draftKey="home"
        holdsFilesUntilSent
        onSubmit={async () => {}}
      />
    </div>
  ),
});

const router = createRouter({
  history: createBrowserHistory(),
  routeTree: rootRoute.addChildren([
    conversationRoute,
    homeRoute,
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
