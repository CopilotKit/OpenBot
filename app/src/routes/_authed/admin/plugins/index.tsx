import { createFileRoute } from "@tanstack/react-router";
import { McpAllowlistSection } from "@/components/admin/controls/mcp-allowlist-section";
import { PluginsListPage } from "@/components/manage/plugins-list-page";

export const Route = createFileRoute("/_authed/admin/plugins/")({
  component: AdminPluginsPage,
});

/** The apps and servers, then the allowlist of MCP servers Bots may call. */
function AdminPluginsPage() {
  return (
    <PluginsListPage>
      <McpAllowlistSection />
    </PluginsListPage>
  );
}
