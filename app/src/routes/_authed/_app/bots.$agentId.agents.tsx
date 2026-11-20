import { createFileRoute, redirect } from "@tanstack/react-router";

/** A Bot has no Agents page. The address stays for old links and leads to the Bot's page. */
export const Route = createFileRoute("/_authed/_app/bots/$agentId/agents")({
  beforeLoad: ({ params }) => {
    throw redirect({
      to: "/bots/$agentId",
      params: { agentId: params.agentId },
      replace: true,
    });
  },
});
