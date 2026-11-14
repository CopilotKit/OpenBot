import { createFileRoute } from "@tanstack/react-router";
import { TeamApprovalSettings } from "@/components/approvals/team-settings";
import { TeamPage, YourOwnApprovals } from "@/components/edition/for-a-team";
import { PageShell } from "@/components/layout/page-shell";

export const Route = createFileRoute("/_authed/admin/approvals")({
  component: AdminApprovalsPageInEveryEdition,
});

function AdminApprovalsPage() {
  return (
    <PageShell
      description="Set approval rules for members’ Bots and review requests to use shared accounts."
      title="Approvals"
    >
      <TeamApprovalSettings />
    </PageShell>
  );
}

/** The personal edition shows this page's title, and that it applies to a team. */
function AdminApprovalsPageInEveryEdition() {
  return (
    <TeamPage
      description="Set approval rules for members’ Bots and review requests to use shared accounts."
      more={<YourOwnApprovals />}
      title="Approvals"
    >
      <AdminApprovalsPage />
    </TeamPage>
  );
}
