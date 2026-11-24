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
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { BotsPanel } from "@/components/app-sidebar/bots-panel";
import { ChannelChat } from "@/components/channels/channel-chat";
import { SidebarShell } from "@/components/layout/sidebar-shell";
import { ThemeProvider } from "@/components/theme-provider";
import { TooltipProvider } from "@/components/ui/tooltip";
import { type AgentProfile, agentKeys } from "@/lib/agents/queries";
import {
  type AgentChannel,
  type ChannelPage,
  channelKeys,
} from "@/lib/channels/queries";
import { withClientName } from "@/lib/client";
import {
  organizationHeaders,
  setCurrentOrganization,
} from "@/lib/organizations/current";
import { queryClient } from "@/query-client";
import { Route as BotRoute } from "@/routes/_authed/_app/bot";
import { Route as HomeRoute } from "@/routes/_authed/_app/index";
import { Route as AuditRoute } from "@/routes/_authed/admin/audit";

/**
 * The app as organization-unavailable-chat.test.tsx loads it in a browser: a conversation with a
 * Bot (the real conversation, with CopilotKit's runtime client set up as the app sets it up), the
 * Bot's own chat page, home and its message box (a message sent opens a placeholder that says so),
 * the sidebar's Bots panel, and Admin's audit log with its filters. Everything is read from the test's server, in
 * Northwind (organization-notices-browser.ts), which the test can move or take out of reach.
 *
 * The conversation's row is put in the roster here and kept, so the page asks the server only for
 * what the conversation itself reads, as conversation-access-ended.fixture.tsx does.
 */
setCurrentOrganization("org_northwind");

export const CONVERSATION: AgentChannel = {
  id: "conversation-northwind",
  name: "General Assistant",
  agentIds: ["general-assistant"],
  threadId: "thread-northwind",
  active: true,
  lastMessageAt: "2026-11-24T09:20:00.000Z",
};

queryClient.setQueryDefaults(channelKeys.list(), { staleTime: Infinity });
queryClient.setQueryData<InfiniteData<ChannelPage>>(channelKeys.list(), {
  pages: [
    {
      channels: [
        {
          ...CONVERSATION,
          summary: "Daily freight check",
          lastMessage: "1223",
          lastMessageAgentId: "general-assistant",
          createdAt: "2026-11-24T09:19:00.000Z",
          pinned: false,
          lastReadAt: "2026-11-24T09:20:00.000Z",
        },
      ],
      nextCursor: null,
    },
  ],
  pageParams: [""],
});

/** Northwind's three Bots, as the list the app reads gives them: read before the move, and kept. */
function bot(id: string, name: string): AgentProfile {
  return {
    assignedToMe: false,
    keyFromOpenBot: false,
    avatarSeed: name,
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
    name,
    roleDescription: "Helps with everyday work.",
    systemOwned: false,
    title: "Assistant",
    visibility: "public",
    id,
    runsOnOpenBotModel: true,
  };
}
queryClient.setQueryDefaults(agentKeys.list(false), { staleTime: Infinity });
queryClient.setQueryData(agentKeys.list(false), [
  bot("general-assistant", "General Assistant"),
  bot("knowledge", "Knowledge"),
  bot("risk-analyst", "Risk Analyst"),
]);

/*
 * The runtime client as `CopilotProvider` (lib/copilot/provider.tsx) sets it up, without the
 * generative UI it registers: that pulls in a map library this bundler can't resolve, and nothing
 * here draws one.
 */
const rootRoute = createRootRoute({
  component: () => (
    <CopilotKitProvider
      credentials="include"
      enableInspector={false}
      headers={withClientName(organizationHeaders("org_northwind"))}
      runtimeUrl="/api/copilotkit"
    >
      <div className="flex h-svh flex-col overflow-hidden">
        <Outlet />
      </div>
    </CopilotKitProvider>
  ),
});

/*
 * The Bot's page reads its search through its own route (`Route.useSearch()`), by the id the app's
 * route tree gives it, so it sits under the same two pathless layouts here: `/_authed/_app/bot`.
 */
const authedRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "_authed",
});
const appRoute = createRoute({
  getParentRoute: () => authedRoute,
  id: "_app",
});
const Audit = AuditRoute.options.component as () => ReactNode;

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
    createRoute({
      getParentRoute: () => rootRoute,
      path: "/bots-panel",
      component: () => (
        <SidebarShell className="h-svh overflow-hidden">
          <div className="w-80 border-r">
            <BotsPanel />
          </div>
        </SidebarShell>
      ),
    }),
    createRoute({
      getParentRoute: () => rootRoute,
      path: "/conversation",
      component: () => (
        <ChannelChat
          channel={CONVERSATION}
          runtimeAgentId="general-assistant"
        />
      ),
    }),
    authedRoute.addChildren([
      appRoute.addChildren([
        createRoute({
          getParentRoute: () => appRoute,
          path: "bot",
          validateSearch: (search: Record<string, unknown>) =>
            (
              BotRoute.options.validateSearch as (
                search: Record<string, unknown>,
              ) => { agent?: string; watch?: boolean }
            )(search),
          component: BotRoute.options.component as () => ReactNode,
        }),
      ]),
    ]),
    createRoute({
      getParentRoute: () => rootRoute,
      path: "/admin/audit",
      component: () => (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <Audit />
        </div>
      ),
    }),
  ]),
});

(window as unknown as { openbotRouter: unknown }).openbotRouter = router;

const root = document.getElementById("root");
if (root)
  createRoot(root).render(
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <TooltipProvider>
          <RouterProvider router={router as never} />
        </TooltipProvider>
      </ThemeProvider>
    </QueryClientProvider>,
  );
