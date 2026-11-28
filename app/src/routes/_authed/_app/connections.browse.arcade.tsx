import { createFileRoute } from "@tanstack/react-router";
import { BrokerDirectoryPage } from "@/components/manage/broker-directory-page";

/* Browse apps, from Connections, in both editions. See connections.browse.composio.tsx. */
export const Route = createFileRoute("/_authed/_app/connections/browse/arcade")(
  {
    component: () => (
      <BrokerDirectoryPage place="connections" provider="arcade" />
    ),
  },
);
