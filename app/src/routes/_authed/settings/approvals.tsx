import { createFileRoute } from "@tanstack/react-router";
import { ApprovalSettings } from "@/components/approvals/settings";
import { PageShell } from "@/components/layout/page-shell";

export const Route = createFileRoute("/_authed/settings/approvals")({
  component: ApprovalsSettingsPage,
});

function ApprovalsSettingsPage() {
  return (
    <PageShell
      description="Whether your Bots ask before they change things, and rules that apply to all of them."
      title="Approvals"
    >
      <ApprovalSettings />
    </PageShell>
  );
}
