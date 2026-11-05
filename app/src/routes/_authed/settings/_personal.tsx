import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { deploymentCapabilitiesQueryOptions } from "@/lib/deployment/queries";

/**
 * What the personal edition keeps of Admin: the plugins, skills, credentials, computer and activity
 * pages, under Settings because there is no Admin to hold them.
 *
 * Pathless, so it adds a guard and no segment. The team edition has these pages under Admin and
 * nowhere else, so an address here sends it back to Settings; so does a deployment whose edition
 * could not be read, which is the team edition's answer too.
 */
export const Route = createFileRoute("/_authed/settings/_personal")({
  beforeLoad: async ({ context }) => {
    const capabilities = await context.queryClient
      .ensureQueryData(deploymentCapabilitiesQueryOptions())
      .catch(() => undefined);
    if (capabilities?.edition !== "personal") {
      throw redirect({ to: "/settings" });
    }
  },
  component: Outlet,
});
