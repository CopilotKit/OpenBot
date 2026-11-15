import { createFileRoute, redirect } from "@tanstack/react-router";

/** Teams moved out of Admin, and each team's page with them. */
export const Route = createFileRoute("/_authed/admin/teams_/$teamId")({
  beforeLoad: ({ params }) => {
    throw redirect({
      to: "/teams/$teamId",
      params: { teamId: params.teamId },
      replace: true,
    });
  },
});
