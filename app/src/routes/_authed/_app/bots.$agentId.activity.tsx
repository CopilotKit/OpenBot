import { createFileRoute, redirect } from "@tanstack/react-router";

/** The Activity page is a tab of the Bot's own page now. */
export const Route = createFileRoute("/_authed/_app/bots/$agentId/activity")({
  beforeLoad: ({ params }) => {
    throw redirect({
      to: "/bots/$agentId",
      params: { agentId: params.agentId },
      search: { tab: "activity" },
      replace: true,
    });
  },
});
