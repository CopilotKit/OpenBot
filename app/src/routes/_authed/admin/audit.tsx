import { createFileRoute } from "@tanstack/react-router";
import { AuditPage } from "@/components/manage/audit-page";

/** Read surface for policy, computer, component, MCP, and credential audit events. */
export const Route = createFileRoute("/_authed/admin/audit")({
  component: AuditPage,
});
