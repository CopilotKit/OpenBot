import { createFileRoute } from "@tanstack/react-router";
import { BrokerDirectoryPage } from "@/components/manage/broker-directory-page";

/*
 * Browse apps, from Connections, in both editions. Whoever opens it finds an app to use: the
 * personal edition's one person and an organization's admin add and connect it in one press, and a
 * member asks an admin for it (`directoryPressMode`).
 */
export const Route = createFileRoute(
  "/_authed/_app/connections/browse/composio",
)({
  component: () => (
    <BrokerDirectoryPage place="connections" provider="composio" />
  ),
});
