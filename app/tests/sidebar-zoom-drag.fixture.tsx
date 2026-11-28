import { IconMessages, IconRobot } from "@tabler/icons-react";
import { QueryClientProvider } from "@tanstack/react-query";
import {
  createBrowserHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { AdminSidebar } from "@/components/admin/admin-sidebar";
import { BotsPanel } from "@/components/app-sidebar/bots-panel";
import { ConversationsPanel } from "@/components/app-sidebar/conversations-panel";
import { SectionPanel } from "@/components/layout/section-panel";
import { SidebarShell } from "@/components/layout/sidebar-shell";
import { Strip, StripItem } from "@/components/layout/strip";
import { SettingsSidebar } from "@/components/settings/settings-sidebar";
import {
  Sidebar,
  SidebarContent,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from "@/components/ui/sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";
import { setCurrentOrganization } from "@/lib/organizations/current";
import { queryClient } from "@/query-client";

/**
 * The three shells' sidebars as sidebar-zoom-drag.test.tsx loads them in a browser: the shells' own
 * `SidebarShell`, sidebar, rail and inset page. With `?strip=1` it is the app's (a strip of sections
 * beside a panel, as `AppSidebar` draws it); without, Admin's and Settings' (one panel).
 *
 * With `?screen=` it is one of the real sidebars, its data from the test's routes: `conversations`
 * and `bots`, the app's panels beside the strip, and `settings` and `admin`, those shells' own
 * sidebars. That is what the narrowest sidebar is read against: every heading in it whole.
 */
const query = new URLSearchParams(location.search);
const strip = query.get("strip") === "1";
const screen = query.get("screen");

setCurrentOrganization("default");

const ROWS = [
  "Quarterly planning with the finance team",
  "Draft the launch announcement",
  "Summarise yesterday's support tickets",
];

function Rows() {
  return (
    <SidebarContent>
      <SidebarMenu className="p-2">
        {ROWS.map((row) => (
          <SidebarMenuItem key={row}>
            <SidebarMenuButton>
              <IconMessages />
              <span>{row}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        ))}
      </SidebarMenu>
    </SidebarContent>
  );
}

/** The app's sidebar: the strip, and beside it `panel`, as `AppSidebar` lays them out. */
function AppShaped({ panel }: { panel: ReactNode }) {
  return (
    <SidebarShell
      className="h-svh overflow-hidden"
      panel={{ available: true, reveal: () => {} }}
    >
      <Sidebar className="overflow-hidden" collapsible="icon" variant="inset">
        <div className="flex h-full min-h-0 flex-row">
          <Strip>
            <StripItem active icon={IconMessages} label="Conversations" />
            <StripItem icon={IconRobot} label="Bots" />
          </Strip>
          {panel}
        </div>
        <SidebarRail />
      </Sidebar>
      <SidebarInset className="min-h-0 overflow-hidden">
        <div className="p-6">The page</div>
      </SidebarInset>
    </SidebarShell>
  );
}

function OnePanel({ sidebar }: { sidebar?: ReactNode }) {
  return (
    <SidebarShell className="h-svh overflow-hidden">
      {sidebar ?? (
        <Sidebar variant="inset">
          <Rows />
          <SidebarRail />
        </Sidebar>
      )}
      <SidebarInset className="min-h-0 min-w-0 overflow-hidden">
        <div className="p-6">The page</div>
      </SidebarInset>
    </SidebarShell>
  );
}

function Screen() {
  switch (screen) {
    case "conversations":
      return <AppShaped panel={<ConversationsPanel />} />;
    case "bots":
      return <AppShaped panel={<BotsPanel />} />;
    case "settings":
      return <OnePanel sidebar={<SettingsSidebar />} />;
    case "admin":
      return <OnePanel sidebar={<AdminSidebar />} />;
    default:
      return strip ? (
        <AppShaped
          panel={
            <SectionPanel title="Conversations">
              <Rows />
            </SectionPanel>
          }
        />
      ) : (
        <OnePanel />
      );
  }
}

const router = createRouter({
  history: createBrowserHistory(),
  routeTree: createRootRoute({ component: Screen }),
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
