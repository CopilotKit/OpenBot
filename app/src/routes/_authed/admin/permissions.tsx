import { createFileRoute } from "@tanstack/react-router";
import { CapabilitiesSection } from "@/components/admin/controls/capabilities-section";
import { TeamPage } from "@/components/edition/for-a-team";
import { PageShell } from "@/components/layout/page-shell";

export const Route = createFileRoute("/_authed/admin/permissions")({
  component: PermissionsPageInEveryEdition,
});

/** Admin, Permissions: what people may do with Bots, for everybody and per role or group. */
export function PermissionsPage() {
  return (
    <PageShell
      description="Each switch applies to everybody. A role can override it, and a directory group can get a permission the organization has off. All changes appear in Activity."
      title="Permissions"
    >
      <CapabilitiesSection />
    </PageShell>
  );
}

/** The personal edition shows this page's title, and that it applies to a team. */
function PermissionsPageInEveryEdition() {
  return (
    <TeamPage
      description="Each switch applies to everybody. A role can override it, and a directory group can get a permission the organization has off. All changes appear in Activity."
      title="Permissions"
    >
      <PermissionsPage />
    </TeamPage>
  );
}
