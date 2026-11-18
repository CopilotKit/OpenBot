import { createFileRoute } from "@tanstack/react-router";
import { TeamsPage } from "@/components/teams/teams-page";

/**
 * The organization's teams, for everybody in it. What each person may do here is the server's
 * verdict on them, so the one page serves a member, a team's maintainer and an admin.
 */
export const Route = createFileRoute("/_authed/_app/teams")({
  component: TeamsPage,
});
