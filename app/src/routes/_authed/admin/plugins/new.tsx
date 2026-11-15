import { createFileRoute } from "@tanstack/react-router";
import { AddServerPage } from "@/components/connections/add-server-page";

/** The same registration flow as Connections, reached from the administrator's app list. */
export const Route = createFileRoute("/_authed/admin/plugins/new")({
  component: () => (
    <AddServerPage
      back={{ label: "Plugins", linkProps: { to: "/admin/plugins" } }}
    />
  ),
});
