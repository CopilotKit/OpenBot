import { createFileRoute, redirect } from "@tanstack/react-router";

/**
 * One Bot and one app, which in the team edition is under Admin. The personal edition gives every
 * Bot every tool, so there is nothing to choose for one Bot: this opens the app's own page.
 */
export const Route = createFileRoute(
  "/_authed/_app/connections/$key_/bots/$agentId",
)({
  beforeLoad: ({ params }) => {
    throw redirect({ to: "/connections/$key", params: { key: params.key } });
  },
});
