import { createFileRoute, redirect } from "@tanstack/react-router";

/** A Bot's goals are rows of its Routines list now. */
export const Route = createFileRoute(
  "/_authed/_app/bots/$agentId/responsibilities",
)({
  beforeLoad: ({ params }) => {
    throw redirect({
      to: "/bots/$agentId/routines",
      params: { agentId: params.agentId },
      replace: true,
    });
  },
});
