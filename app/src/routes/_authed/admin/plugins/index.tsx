import { createFileRoute } from "@tanstack/react-router";
import { PluginsListPage } from "@/components/manage/plugins-list-page";

export const Route = createFileRoute("/_authed/admin/plugins/")({
  component: PluginsListPage,
});
