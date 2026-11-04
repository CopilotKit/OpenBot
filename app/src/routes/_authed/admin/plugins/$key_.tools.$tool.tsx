import { createFileRoute } from "@tanstack/react-router";
import { PluginToolPage } from "@/components/manage/plugin-tool-page";

/** `$key_` opts this route out of nesting under `$key.tsx`, so the connector page stays a page. */
export const Route = createFileRoute(
  "/_authed/admin/plugins/$key_/tools/$tool",
)({ component: RouteComponent });

function RouteComponent() {
  const { key, tool } = Route.useParams();
  return <PluginToolPage pluginKey={key} toolName={tool} />;
}
