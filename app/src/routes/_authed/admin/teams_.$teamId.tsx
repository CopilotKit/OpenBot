import { createFileRoute } from "@tanstack/react-router";
import { TeamDetailPage } from "@/components/teams/team-page";

/** A team's page, inside Admin: the same page as `/teams/$teamId`, in Admin's frame. */
export const Route = createFileRoute("/_authed/admin/teams_/$teamId")({
  component: RouteComponent,
});

function RouteComponent() {
  const { teamId } = Route.useParams();
  // Keyed by the team, so moving from one team to another starts its dialogs afresh.
  return <TeamDetailPage key={teamId} shell="admin" teamId={teamId} />;
}
