import { createFileRoute } from "@tanstack/react-router";
import { NewCredentialPage } from "@/components/manage/new-credential-page";

/** Adding a key to the Vault. Personal only: the team edition's keys are an admin's, under Admin. */
export const Route = createFileRoute("/_authed/settings/_personal/vault_/new")({
  component: NewCredentialPage,
});
