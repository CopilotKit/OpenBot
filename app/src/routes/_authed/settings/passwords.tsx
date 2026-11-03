import { createFileRoute, redirect } from "@tanstack/react-router";
import { PasswordsPage } from "@/components/passwords/passwords-page";
import { editionOf } from "@/lib/edition-guard";

export const Route = createFileRoute("/_authed/settings/passwords")({
  // The personal edition keeps saved logins on Connections, with the apps and keys.
  beforeLoad: async ({ context }) => {
    if ((await editionOf(context.queryClient)) === "personal")
      throw redirect({ to: "/connections/logins" });
  },
  component: PasswordsPage,
});
