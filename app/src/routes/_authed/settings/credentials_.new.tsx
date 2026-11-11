import { createFileRoute, redirect } from "@tanstack/react-router";
import { deploymentCapabilitiesQueryOptions } from "@/lib/deployment/queries";

/**
 * Adding a key is the Vault's form now, which only the personal edition has outside Admin. So the
 * personal edition goes to the form and every other goes to the Vault itself, in one step: sent to
 * the form, the team edition would be sent on again by that form's guard and end on General.
 */
export const Route = createFileRoute("/_authed/settings/credentials_/new")({
  beforeLoad: async ({ context }) => {
    const capabilities = await context.queryClient
      .ensureQueryData(deploymentCapabilitiesQueryOptions())
      .catch(() => undefined);
    throw redirect({
      to:
        capabilities?.edition === "personal"
          ? "/settings/vault/new"
          : "/settings/vault",
      replace: true,
    });
  },
});
