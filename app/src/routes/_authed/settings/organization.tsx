import { createFileRoute, redirect } from "@tanstack/react-router";
import { OrganizationSettingsPage } from "@/components/organizations/organization-settings-page";
import { ownOrganizationsQueryOptions } from "@/lib/organizations/queries";

export const Route = createFileRoute("/_authed/settings/organization")({
  // Where OpenBot lists no organizations (the personal edition among them) there is none to set.
  beforeLoad: async ({ context }) => {
    const mine = await context.queryClient.ensureQueryData(
      ownOrganizationsQueryOptions(),
    );
    if (!mine || mine.organizations.length === 0) {
      throw redirect({ to: "/settings" });
    }
  },
  component: OrganizationSettingsPage,
});
