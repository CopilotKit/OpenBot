import { createFileRoute } from "@tanstack/react-router";
import { AddServerPage } from "@/components/connections/add-server-page";

/**
 * Apps, Add custom MCP: the same form as Connections' Add custom MCP, opened from Admin's Apps
 * page. Back and Cancel return to Apps, and a server added with nothing more to do is listed there.
 */
export const Route = createFileRoute("/_authed/admin/plugins/new")({
  component: AdminAddServerPage,
});

function AdminAddServerPage() {
  return <AddServerPage from="admin" />;
}
