import { createFileRoute, redirect } from "@tanstack/react-router";

/** Team Bots moved: the roster lists them, and each Bot's Sharing page publishes it. */
export const Route = createFileRoute("/_authed/_app/team-bots")({
  beforeLoad: () => {
    throw redirect({ to: "/bots", replace: true });
  },
});
