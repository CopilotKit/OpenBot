import { createFileRoute } from "@tanstack/react-router";
import { PluginPage } from "@/components/Gerir/plugin-page";
import { useDropBrokerReturn } from "@/lib/connections/broker-return";

export const Route = createFileRoute("/_authed/admin/plugins/$Chave")({
  component: RouteComponent,
});

function RouteComponent() {
  const { key } = Route.useParams();
  useDropBrokerReturn();
  return <PluginPage pluginKey={key} />;
}
