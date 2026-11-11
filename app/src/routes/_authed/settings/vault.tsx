import { createFileRoute } from "@tanstack/react-router";
import { VaultPage } from "@/components/vault/vault-page";

export const Route = createFileRoute("/_authed/settings/vault")({
  component: VaultPage,
});
