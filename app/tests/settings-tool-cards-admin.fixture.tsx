import type { Message } from "@ag-ui/core";
import { CopilotKitProvider } from "@copilotkit/react-core/v2";
import { QueryClientProvider } from "@tanstack/react-query";
import {
  createBrowserHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
  useParams,
} from "@tanstack/react-router";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { AdminSidebar } from "@/components/admin/admin-sidebar";
import { AppSidebar } from "@/components/app-sidebar/app-sidebar";
import { ChatTranscript } from "@/components/channels/chat-transcript";
import { SidebarShell } from "@/components/layout/sidebar-shell";
import { OrganizationSettingsPage } from "@/components/organizations/organization-settings-page";
import { TeamDetailPage } from "@/components/teams/team-page";
import { SidebarInset } from "@/components/ui/sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";
import { setCurrentOrganization } from "@/lib/organizations/current";
import { queryClient } from "@/query-client";
import { Route as PeopleRoute } from "@/routes/_authed/admin/people";
import { PermissionsPage } from "@/routes/_authed/admin/permissions";
import { CALLS, type Call } from "./settings-tool-cards-admin.calls";

/**
 * The admin settings tools' cards (update_organization_settings, manage_people, manage_teams) in a
 * real conversation, beside the Admin screens they change, for
 * settings-tool-cards-admin-layout.test.tsx to load in a browser.
 *
 * Each conversation is the app's own transcript (`ChatTranscript`) given the messages a turn leaves:
 * a call still waiting on the person, which the transcript draws as the approval card from the
 * approvals the test's routes serve, and calls that ran or were refused, with the result the server
 * wrote. That is the same transcript a conversation draws live and after a reload. The Admin screens
 * are the real ones (People, Permissions, a team's page, Organization settings).
 */
setCurrentOrganization("default");

/** The messages one call leaves: the person's ask, the Bot's call, and its result when it has one. */
function turn(call: Call): Message[] {
  const messages: Message[] = [
    { id: `${call.id}-ask`, role: "user", content: call.ask },
    {
      id: `${call.id}-call`,
      role: "assistant",
      content: "",
      toolCalls: [
        {
          id: call.id,
          type: "function",
          function: {
            name: `mcp__openbot-settings__${call.tool}`,
            arguments: JSON.stringify(call.args),
          },
        },
      ],
    },
  ];
  if (call.result !== undefined)
    messages.push({
      id: `${call.id}-result`,
      role: "tool",
      toolCallId: call.id,
      content: call.result,
    });
  return messages;
}

function Conversation() {
  const { scene } = useParams({ strict: false }) as { scene: string };
  const calls = CALLS.filter((call) => call.scene === scene);
  return (
    <div className="flex h-full flex-col bg-background text-foreground">
      <ChatTranscript
        busy={false}
        messages={calls.flatMap(turn)}
        restoring={false}
      />
    </div>
  );
}

function AdminTeamDetail() {
  const { teamId } = useParams({ strict: false }) as { teamId: string };
  return <TeamDetailPage key={teamId} shell="admin" teamId={teamId} />;
}

const rootRoute = createRootRoute({ component: () => <Outlet /> });

const adminRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "admin-frame",
  component: () => (
    <SidebarShell className="h-svh overflow-hidden">
      <AdminSidebar />
      <SidebarInset className="min-h-0 min-w-0 overflow-hidden">
        <Outlet />
      </SidebarInset>
    </SidebarShell>
  ),
});
const admin = (path: string, page: () => ReactNode) =>
  createRoute({ getParentRoute: () => adminRoute, path, component: page });

const appRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "app-frame",
  component: () => (
    <SidebarShell className="h-svh overflow-hidden">
      <AppSidebar />
      <SidebarInset className="min-h-0 overflow-hidden">
        <Outlet />
      </SidebarInset>
    </SidebarShell>
  ),
});
const app = (path: string, page: () => ReactNode) =>
  createRoute({ getParentRoute: () => appRoute, path, component: page });

const router = createRouter({
  history: createBrowserHistory(),
  routeTree: rootRoute.addChildren([
    adminRoute.addChildren([
      admin("/admin/people", PeopleRoute.options.component as () => ReactNode),
      admin("/admin/permissions", PermissionsPage),
      admin("/admin/teams/$teamId", AdminTeamDetail),
    ]),
    appRoute.addChildren([
      app("/conversation/$scene", Conversation),
      app("/settings/organization", OrganizationSettingsPage),
    ]),
    createRoute({
      getParentRoute: () => rootRoute,
      path: "/",
      component: () => null,
    }),
  ]),
});

const root = document.getElementById("root");
if (root)
  createRoot(root).render(
    <QueryClientProvider client={queryClient}>
      <CopilotKitProvider runtimeUrl="/api/copilotkit">
        <TooltipProvider>
          <RouterProvider router={router as never} />
        </TooltipProvider>
      </CopilotKitProvider>
    </QueryClientProvider>,
  );
