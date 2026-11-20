import { createFileRoute } from "@tanstack/react-router";
import { TeamDetailPage } from "@/components/teams/team-page";

export const Route = createFileRoute("/_authed/_app/teams_/$teamId")({
  component: RouteComponent,
});

function RouteComponent() {
  const { teamId } = Route.useParams();
  // Keyed by the team, so moving from one team to another starts its dialogs afresh.
  return <TeamDetailPage key={teamId} teamId={teamId} />;
}
