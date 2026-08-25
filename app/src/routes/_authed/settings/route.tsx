import { createFileRoute, Outlet } from "@tanstack/react-router";
import { SettingsSidebar } from "@/components/settings/settings-sidebar";
import { SidebarProvider } from "@/components/ui/sidebar";

export const Route = createFileRoute("/_authed/settings")({
  component: RouteComponent,
});

function RouteComponent() {
  return (
    <SidebarProvider
      /*
       * The same 300px admin uses: these two rails hold short nav labels, not the roster's
       * two-line previews, so they earn less width than the app shell's 340px.
       */
      style={
        {
          "--sidebar-width": "300px",
          "--sidebar-width-mobile": "20rem",
        } as React.CSSProperties
      }
    >
      <SettingsSidebar />
      <main className="flex-1">
        <Outlet />
      </main>
    </SidebarProvider>
  );
}
