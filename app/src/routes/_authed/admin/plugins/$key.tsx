import { createFileRoute } from "@tanstack/react-router";
import { PluginPage } from "@/components/manage/plugin-page";

export const Route = createFileRoute("/_authed/admin/plugins/$key")({
  component: RouteComponent,
});

function RouteComponent() {
  const { key } = Route.useParams();
  return <PluginPage pluginKey={key} />;
}
