import { createFileRoute } from "@tanstack/react-router";
import { PluginToolPage } from "@/components/manage/plugin-tool-page";
import { personalOnly } from "@/lib/edition-guard";

/** One tool of an app, and which Bots can use it. The personal edition's; see `manage-paths`. */
export const Route = createFileRoute(
  "/_authed/_app/connections/$key_/tools/$tool",
)({ beforeLoad: personalOnly("/connections"), component: RouteComponent });

function RouteComponent() {
  const { key, tool } = Route.useParams();
  return <PluginToolPage pluginKey={key} toolName={tool} />;
}
