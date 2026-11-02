import { createFileRoute, Outlet } from "@tanstack/react-router";
import { SidebarShell } from "@/components/layout/sidebar-shell";
import { SettingsSidebar } from "@/components/settings/settings-sidebar";
import { SidebarInset } from "@/components/ui/sidebar";

export const Route = createFileRoute("/_authed/settings")({
  component: RouteComponent,
});

function RouteComponent() {
  return (
    // The same inset panel as the app's shell; see `_app.tsx`.
    <SidebarShell className="h-svh overflow-hidden" width="300px">
      <SettingsSidebar />
      <SidebarInset className="min-h-0 min-w-0 overflow-hidden">
        <Outlet />
      </SidebarInset>
    </SidebarShell>
  );
}
