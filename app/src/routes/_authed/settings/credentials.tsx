import { createFileRoute, redirect } from "@tanstack/react-router";

/** Keys are the Vault's Keys section now. */
export const Route = createFileRoute("/_authed/settings/credentials")({
  beforeLoad: () => {
    throw redirect({ to: "/settings/vault", replace: true });
  },
});
