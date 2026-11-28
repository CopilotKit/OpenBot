import { createFileRoute } from "@tanstack/react-router";
import { NewTeamPage } from "@/components/teams/new-team-page";

/** New team, inside Admin: the same page as `/teams/new`, in Admin's frame. */
export const Route = createFileRoute("/_authed/admin/teams_/new")({
  component: AdminNewTeamPage,
});

function AdminNewTeamPage() {
  return <NewTeamPage shell="admin" />;
}
