import {
  createFileRoute,
  Outlet,
  useRouterState,
} from "@tanstack/react-router";
import { ConnectionBanner } from "@/components/layout/connection-banner";
import { NativeShellPanel } from "@/components/layout/native-shell-frame";
import { DefaultPageBackProvider } from "@/components/layout/page-shell";
import { PlanBanner } from "@/components/layout/plan-banner";
import { SidebarShell } from "@/components/layout/sidebar-shell";
import { SettingsSidebar } from "@/components/settings/settings-sidebar";
import { SidebarInset } from "@/components/ui/sidebar";
import { nativeShell } from "@/lib/native-shell/shell";

export const Route = createFileRoute("/_authed/settings")({
  component: RouteComponent,
});

function RouteComponent() {
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });
  /*
   * Inside the phone app's native shell, no sidebar (`NativeShellPanel`). General lists the other
   * pages instead (`SettingsPageRows`), and every other page leads back to it.
   */
  if (nativeShell()) {
    return (
      <NativeShellPanel>
        <ConnectionBanner />
        <PlanBanner />
        <DefaultPageBackProvider
          value={
            pathname === "/settings" || pathname === "/settings/"
              ? null
              : { label: "Settings", linkProps: { to: "/settings" } }
          }
        >
          <Outlet />
        </DefaultPageBackProvider>
      </NativeShellPanel>
    );
  }
  return (
    // The same inset panel as the app's shell; see `_app.tsx`.
    <SidebarShell className="h-svh overflow-hidden">
      <SettingsSidebar />
      <SidebarInset className="min-h-0 min-w-0 overflow-hidden">
        <ConnectionBanner />
        <PlanBanner />
        <Outlet />
      </SidebarInset>
    </SidebarShell>
  );
}
