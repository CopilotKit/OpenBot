import { createFileRoute } from "@tanstack/react-router";
import { PasswordsPage } from "@/components/passwords/passwords-page";
import { personalOnly } from "@/lib/edition-guard";

/** Saved website logins, beside the apps and keys. The personal edition's; Settings has it otherwise. */
export const Route = createFileRoute("/_authed/_app/connections/logins")({
  beforeLoad: personalOnly("/settings"),
  component: PasswordsPage,
});
