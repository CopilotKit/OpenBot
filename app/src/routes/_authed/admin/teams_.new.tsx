import { createFileRoute } from "@tanstack/react-router";
import { NewTeamPage } from "@/components/teams/new-team-page";

export const Route = createFileRoute("/_authed/admin/teams_/new")({
  component: NewTeamPage,
});
