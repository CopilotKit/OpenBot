import { createFileRoute } from "@tanstack/react-router";
import { PluginBotPage } from "@/components/manage/plugin-bot-page";

/** `$key_` opts this route out of nesting under `$key.tsx`, so the connector page stays a page. */
export const Route = createFileRoute(
  "/_authed/admin/plugins/$key_/bots/$agentId",
)({ component: RouteComponent });

function RouteComponent() {
  const { key, agentId } = Route.useParams();
  return <PluginBotPage agentId={agentId} pluginKey={key} />;
}
