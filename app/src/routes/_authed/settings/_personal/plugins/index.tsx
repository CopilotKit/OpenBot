import { createFileRoute } from "@tanstack/react-router";
import { PluginsListPage } from "@/components/manage/plugins-list-page";

export const Route = createFileRoute("/_authed/settings/_personal/plugins/")({
  component: PluginsListPage,
});
