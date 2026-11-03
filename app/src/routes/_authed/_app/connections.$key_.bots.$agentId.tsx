import { createFileRoute } from "@tanstack/react-router";
import { PluginBotPage } from "@/components/manage/plugin-bot-page";
import { personalOnly } from "@/lib/edition-guard";

/** One Bot and one app: which of its tools the Bot can use. The personal edition's; see `manage-paths`. */
export const Route = createFileRoute(
  "/_authed/_app/connections/$key_/bots/$agentId",
)({ beforeLoad: personalOnly("/connections"), component: RouteComponent });

function RouteComponent() {
  const { key, agentId } = Route.useParams();
  return <PluginBotPage agentId={agentId} pluginKey={key} />;
}
