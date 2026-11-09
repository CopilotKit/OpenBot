import {
  createFileRoute,
  useNavigate,
  useSearch,
} from "@tanstack/react-router";
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

/**
 * The log, then what else is recorded and where it is exported.
 *
 * Search is read without `strict`, so the page also renders where it is mounted on a route of
 * another name, as the audit tests do. The route's own `validateSearch` has already checked it.
 */
function AdminAuditPage() {
  const { bot } = useSearch({ strict: false }) as { bot?: string };
  const navigate = useNavigate();
  return (
    <AuditPage
      ask
      bot={bot}
      onClearBot={() => navigate({ to: "/admin/audit" })}
    >
      <RecordingSection />
    </AuditPage>
  );
}
