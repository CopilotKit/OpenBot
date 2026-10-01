import { createFileRoute } from "@tanstack/react-router";
import { ApprovalInbox } from "@/components/approvals/inbox";
import { PageShell } from "@/components/layout/page-shell";
export const Route = createFileRoute("/_authed/_app/approvals")({
  component: ApprovalsPage,
});
function ApprovalsPage() {
  return (
    <PageShell
      title="Approvals"
      description="Choose what your Bots may do, and review actions waiting for you."
    >
      <ApprovalInbox />
    </PageShell>
  );
}
