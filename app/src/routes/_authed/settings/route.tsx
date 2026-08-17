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
       * The same 340px the app shell uses. Settings is a different screen, not a different product,
       * and a rail that changes width on the way in makes the whole frame look like it moved.
       */
      style={
        {
          "--sidebar-width": "340px",
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
