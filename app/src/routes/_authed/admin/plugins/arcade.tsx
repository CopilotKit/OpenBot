import { createFileRoute } from "@tanstack/react-router";
import { BrokerDirectoryPage } from "@/components/manage/broker-directory-page";

/** Arcade's directory, behind the guard that it answers only on an Arcade deployment. */
export const Route = createFileRoute("/_authed/admin/plugins/arcade")({
  component: () => <BrokerDirectoryPage provider="arcade" />,
});
