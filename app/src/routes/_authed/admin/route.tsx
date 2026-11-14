import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { AdminSidebar } from "@/components/admin/admin-sidebar";
import { SidebarShell } from "@/components/layout/sidebar-shell";
import { SidebarInset } from "@/components/ui/sidebar";
import { deploymentCapabilitiesQueryOptions } from "@/lib/deployment/queries";
import { currentUserQueryOptions } from "../../../lib/auth/queries";

export const Route = createFileRoute("/_authed/admin")({
  /*
   * Admin is for an admin, in every edition. In the personal edition the one person is the admin:
   * single-user mode signs them in as one (`DEV_ACTOR` on the server).
   *
   * The edition is read first, though nothing here depends on it: a page that draws something else
   * in the personal edition (`components/edition/for-a-team.tsx`) then knows which on its first
   * frame. One that could not be read is the team edition, as everywhere else.
   */
  beforeLoad: async ({ context }) => {
    await context.queryClient
      .ensureQueryData(deploymentCapabilitiesQueryOptions())
      .catch(() => undefined);
    const user = await context.queryClient.ensureQueryData(
      currentUserQueryOptions(),
    );
    if (user?.role !== "admin") {
      throw redirect({ to: "/" });
    }
  },
  component: RouteComponent,
});

function RouteComponent() {
  return (
    // The same inset panel as the app's shell; see `_app.tsx`.
    <SidebarShell className="h-svh overflow-hidden">
      <AdminSidebar />
      <SidebarInset className="min-h-0 min-w-0 overflow-hidden">
        <Outlet />
      </SidebarInset>
    </SidebarShell>
  );
}
