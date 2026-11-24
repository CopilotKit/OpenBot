import { createFileRoute, Outlet } from "@tanstack/react-router";
import { AppSidebar } from "@/components/app-sidebar/app-sidebar";
import { ConnectionBanner } from "@/components/layout/connection-banner";
import { PlanBanner } from "@/components/layout/plan-banner";
import { SelfHostBanner } from "@/components/layout/self-host-banner";
import { SidebarShell } from "@/components/layout/sidebar-shell";
import { UpdateBanner } from "@/components/layout/update-banner";
import { MovedAppsBanner } from "@/components/moves/moved-apps-notice";
import { MovedElsewhereBanner } from "@/components/moves/moved-elsewhere-banner";
import { LeftOrganizationBanner } from "@/components/organizations/left-organization-banner";
import { SidebarInset } from "@/components/ui/sidebar";
import {
  CONVERSATIONS,
  SectionProvider,
  sectionHasPanel,
  useOpenSection,
} from "@/lib/sections";
import { useActiveSkin } from "@/skins/registry";

export const Route = createFileRoute("/_authed/_app")({
  component: RouteComponent,
});

function RouteComponent() {
  const { Frame } = useActiveSkin();

  if (Frame) {
    return (
      <Frame>
        <Outlet />
      </Frame>
    );
  }

  return (
    <SectionProvider>
      <AppFrame />
    </SectionProvider>
  );
}

/**
 * The default frame: the strip and its panel beside the page. A section with no panel folds the
 * panel away; asking for it there opens Conversations, the section that has one.
 */
function AppFrame() {
  const { section, show } = useOpenSection();
  return (
    /*
     * The content sits in a panel inset from the window, on the sidebar's tint, so the sidebar and
     * the window's edge read as one frame and the page as the thing inside it. Before, the sidebar,
     * the page and the cards on it were three near-identical whites told apart only by hairlines.
     *
     * One viewport, never scrolls: panes scroll inside the panel, which is also what keeps its
     * rounded corners on screen. A growable shell lets the transcript's scroller size against the
     * page, grow it, and grow again. Admin and settings use the same panel.
     */
    <SidebarShell
      className="h-svh overflow-hidden"
      panel={{
        available: sectionHasPanel(section),
        reveal: () => show(CONVERSATIONS),
      }}
    >
      <AppSidebar />
      <SidebarInset className="min-h-0 overflow-hidden">
        <ConnectionBanner />
        <LeftOrganizationBanner />
        <PlanBanner />
        <MovedElsewhereBanner />
        <MovedAppsBanner />
        <UpdateBanner />
        <SelfHostBanner />
        <Outlet />
      </SidebarInset>
    </SidebarShell>
  );
}
