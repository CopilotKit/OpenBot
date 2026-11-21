import { createFileRoute } from "@tanstack/react-router";
import { NewCredentialPage } from "@/components/Gerir/new-credential-page";

/** Adding a key to the Vault. Personal only: the team edition's Chaves are an admin's, under Admin. */
export const Route = createFileRoute("/_authed/settings/_personal/vault_/new")({
  component: NewCredentialPage,
});
