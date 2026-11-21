import { createFileRoute } from "@tanstack/react-router";
import { BrokerDirectoryPage } from "@/components/Gerir/broker-directory-page";
import { personalOnly } from "@/lib/edition-guard";

export const Route = createFileRoute(
  "/_authed/_app/connections/browse/composio",
)({
  beforeLoad: personalOnly("/connections"),
  component: () => <BrokerDirectoryPage provider="composio" />,
});
