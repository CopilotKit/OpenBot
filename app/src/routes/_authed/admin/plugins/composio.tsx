import { createFileRoute } from "@tanstack/react-router";
import { BrokerDirectoryPage } from "@/components/manage/broker-directory-page";

/** Composio's directory, behind the guard that it answers only on a Composio deployment. */
export const Route = createFileRoute("/_authed/admin/plugins/composio")({
  component: () => <BrokerDirectoryPage provider="composio" />,
});
