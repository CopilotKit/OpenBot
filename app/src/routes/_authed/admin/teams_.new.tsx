import { createFileRoute, redirect } from "@tanstack/react-router";

/** Teams moved out of Admin, and New team with them. */
export const Route = createFileRoute("/_authed/admin/teams_/new")({
  beforeLoad: () => {
    throw redirect({ to: "/teams/new", replace: true });
  },
});
