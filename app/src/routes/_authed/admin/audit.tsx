import { createFileRoute } from "@tanstack/react-router";
import { RecordingSection } from "@/components/admin/controls/recording-section";
import { AuditPage } from "@/components/manage/audit-page";

/** Read surface for policy, computer, component, MCP, and credential audit events. */
export const Route = createFileRoute("/_authed/admin/audit")({
  component: AdminAuditPage,
});

/** The log, then what else is recorded and where it is exported. */
function AdminAuditPage() {
  return (
    <AuditPage>
      <RecordingSection />
    </AuditPage>
  );
}
