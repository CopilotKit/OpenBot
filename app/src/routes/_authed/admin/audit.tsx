import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { RecordingSection } from "@/components/admin/controls/recording-section";
import { AuditPage } from "@/components/manage/audit-page";

/**
 * Read surface for policy, computer, component, MCP, and credential audit events. `bot` narrows it
 * to one Bot, which is how a Bot's own Activity page links here.
 */
export const Route = createFileRoute("/_authed/admin/audit")({
  validateSearch: z.object({ bot: z.string().optional() }),
  component: AdminAuditPage,
});

/** The log, then what else is recorded and where it is exported. */
function AdminAuditPage() {
  const { bot } = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <AuditPage
      bot={bot}
      onClearBot={() => navigate({ search: { bot: undefined } })}
    >
      <RecordingSection />
    </AuditPage>
  );
}
