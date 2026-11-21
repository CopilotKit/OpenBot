import { createFileRoute } from "@tanstack/react-router";
import { TeamsPage } from "@/components/teams/teams-page";

/**
 * The organization's teams, inside Admin, for an admin who opens Teams from Admin's sidebar. The
 * same page everybody opens at `/teams`, drawn in Admin's frame so Admin does not close under them;
 * its links stay under `/admin/teams`.
 */
export const Route = createFileRoute("/_authed/admin/teams")({
  component: AdminTeamsPage,
});

function AdminTeamsPage() {
  return <TeamsPage shell="admin" />;
}
