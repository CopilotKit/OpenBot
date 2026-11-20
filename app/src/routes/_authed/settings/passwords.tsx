import { createFileRoute, redirect } from "@tanstack/react-router";

/** Saved logins are the Vault's Logins section now. */
export const Route = createFileRoute("/_authed/settings/passwords")({
  beforeLoad: () => {
    throw redirect({ to: "/settings/vault", replace: true });
  },
});
