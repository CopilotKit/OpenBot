import { createFileRoute } from "@tanstack/react-router";
import { PasswordsPage } from "@/components/passwords/passwords-page";

export const Route = createFileRoute("/_authed/settings/passwords")({
  component: PasswordsPage,
});
