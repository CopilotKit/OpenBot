import { createFileRoute, Outlet } from "@tanstack/react-router";
import { AppSidebar } from "@/components/app-sidebar/app-sidebar";
import { SelfHostBanner } from "@/components/layout/self-host-banner";
import { SidebarShell } from "@/components/layout/sidebar-shell";
import { SidebarInset } from "@/components/ui/sidebar";
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
    /*
     * The content sits in a panel inset from the window, on the sidebar's tint, so the sidebar and
     * the window's edge read as one frame and the page as the thing inside it. Before, the sidebar,
     * the page and the cards on it were three near-identical whites told apart only by hairlines.
     *
     * One viewport, never scrolls: panes scroll inside the panel, which is also what keeps its
     * rounded corners on screen. A growable shell lets the transcript's scroller size against the
     * page, grow it, and grow again. Admin and settings use the same panel.
     */
    <SidebarShell className="h-svh overflow-hidden" width="340px">
      <AppSidebar />
      <SidebarInset className="min-h-0 overflow-hidden">
        <SelfHostBanner />
        <Outlet />
      </SidebarInset>
    </SidebarShell>
  );
}
