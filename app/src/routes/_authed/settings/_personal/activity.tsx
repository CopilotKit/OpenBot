import { createFileRoute } from "@tanstack/react-router";
import { AuditPage } from "@/components/manage/audit-page";

export const Route = createFileRoute("/_authed/settings/_personal/activity")({
  component: AuditPage,
});
