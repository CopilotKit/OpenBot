import { IconMessages, IconRobot } from "@tabler/icons-react";
import { createRoot } from "react-dom/client";
import { SectionPanel } from "@/components/layout/section-panel";
import { SidebarShell } from "@/components/layout/sidebar-shell";
import { Strip, StripItem } from "@/components/layout/strip";
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

/**
 * The three shells' sidebars as sidebar-zoom-drag.test.tsx loads them in a browser: the shells' own
 * `SidebarShell`, sidebar, rail and inset page. With `?strip=1` it is the app's (a strip of sections
 * beside a panel, as `AppSidebar` draws it); without, Admin's and Settings' (one panel).
 */
const strip = new URLSearchParams(location.search).get("strip") === "1";

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

function AppShaped() {
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
          <SectionPanel title="Conversations">
            <Rows />
          </SectionPanel>
        </div>
        <SidebarRail />
      </Sidebar>
      <SidebarInset className="min-h-0 overflow-hidden">
        <div className="p-6">The page</div>
      </SidebarInset>
    </SidebarShell>
  );
}

function OnePanel() {
  return (
    <SidebarShell className="h-svh overflow-hidden">
      <Sidebar variant="inset">
        <Rows />
        <SidebarRail />
      </Sidebar>
      <SidebarInset className="min-h-0 min-w-0 overflow-hidden">
        <div className="p-6">The page</div>
      </SidebarInset>
    </SidebarShell>
  );
}

const root = document.getElementById("root");
if (root)
  createRoot(root).render(
    <TooltipProvider>{strip ? <AppShaped /> : <OnePanel />}</TooltipProvider>,
  );
