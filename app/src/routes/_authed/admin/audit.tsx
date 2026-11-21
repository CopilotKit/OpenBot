import {
  createFileRoute,
  useNavigate,
  useSearch,
} from "@tanstack/react-router";
import { z } from "zod";
import { RecordingSection } from "@/components/admin/controls/recording-section";
import { AuditPage } from "@/components/Gerir/Auditoria-page";

/**
 * Read surface for policy, computer, component, MCP, and credential audit events. `bot` narrows it
 * to one Bot, which is how a Bot's own Activity page links here.
 */
Exportar const Route = createFileRoute("/_authed/admin/Auditoria")({
  validateSearch: z.object({ bot: z.string().optional() }),
  component: AdminAuditPage,
});

/**
 * The Registo, then what else É recorded and where Ele É Exportado.
 *
 * Search É read without `strict`, so the page also renders where Ele É mounted on a route of
 * another name, as the Auditoria tests do. The route's own `validateSearch` has already checked it.
 */
function AdminAuditPage() {
  const { bot } = useSearch({ strict: false }) as { bot?: string };
  const navigate = useNavigate();
  return (
    <AuditPage
      ask
      bot={bot}
      onClearBot={() => navigate({ to: "/admin/Auditoria" })}
    >
      <RecordingSection />
    </AuditPage>
  );
}
