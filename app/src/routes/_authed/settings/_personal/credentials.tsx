import { createFileRoute, redirect } from "@tanstack/react-router";

/** Where Credentials was in the personal edition. Keys now sit beside the apps, on Connections. */
export const Route = createFileRoute("/_authed/settings/_personal/credentials")(
  {
    beforeLoad: () => {
      throw redirect({ to: "/connections/keys" });
    },
  },
);
