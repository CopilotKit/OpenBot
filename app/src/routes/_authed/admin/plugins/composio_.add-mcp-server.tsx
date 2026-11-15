import { createFileRoute, redirect } from "@tanstack/react-router";

/** Keep a direct link from the Composio directory on the provider-independent registration page. */
export const Route = createFileRoute(
  "/_authed/admin/plugins/composio_/add-mcp-server",
)({
  beforeLoad: () => {
    throw redirect({ to: "/admin/plugins/new", replace: true });
  },
});
