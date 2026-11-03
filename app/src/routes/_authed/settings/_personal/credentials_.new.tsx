import { createFileRoute, redirect } from "@tanstack/react-router";

/** Where adding a credential was in the personal edition. See `credentials.tsx`. */
export const Route = createFileRoute(
  "/_authed/settings/_personal/credentials_/new",
)({
  beforeLoad: () => {
    throw redirect({ to: "/connections/keys/new" });
  },
});
