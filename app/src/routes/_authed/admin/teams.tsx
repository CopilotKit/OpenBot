import { createFileRoute } from "@tanstack/react-router";
import { TeamsPage } from "@/components/teams/teams-page";

export const Route = createFileRoute("/_authed/admin/teams")({
  component: TeamsPage,
});
