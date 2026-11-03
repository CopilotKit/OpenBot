import { createFileRoute } from "@tanstack/react-router";
import { BrokerDirectoryPage } from "@/components/manage/broker-directory-page";

export const Route = createFileRoute(
  "/_authed/settings/_personal/plugins/composio",
)({ component: () => <BrokerDirectoryPage provider="composio" /> });
