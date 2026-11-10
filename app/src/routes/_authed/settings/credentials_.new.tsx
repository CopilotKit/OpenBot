import { createFileRoute, redirect } from "@tanstack/react-router";

/**
 * Adding a key is the Vault's form now. The team edition has no such form outside Admin, and the
 * Vault's own guard sends it back to Settings.
 */
export const Route = createFileRoute("/_authed/settings/credentials_/new")({
  beforeLoad: () => {
    throw redirect({ to: "/settings/vault/new", replace: true });
  },
});
