import { createFileRoute, redirect } from "@tanstack/react-router";

/**
 * Skills and access (What it can do, in the personal edition) is split by kind: the Bot's Apps and
 * Skills pages, its Approvals, and hand-offs on its Setup. An old link opens Apps, where most of
 * what it showed went.
 */
export const Route = createFileRoute("/_authed/_app/bots/$agentId/access")({
  beforeLoad: ({ params }) => {
    throw redirect({
      to: "/bots/$agentId/apps",
      params: { agentId: params.agentId },
      replace: true,
    });
  },
});
