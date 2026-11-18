import { createFileRoute } from "@tanstack/react-router";
import { BotSubpage } from "@/components/bot-profile/bot-subpage";
import { BotDelegation } from "@/components/bot-profile/delegation";

export const Route = createFileRoute("/_authed/_app/bots/$agentId/agents")({
  component: AgentsPage,
});

/**
 * A Bot's Agents: whether it does the work itself on its one agent, or answers quickly and hands the
 * work to the agents it may use, with its model and how it hands out work.
 */
function AgentsPage() {
  const { agentId } = Route.useParams();
  return (
    <BotSubpage
      agentId={agentId}
      description="Choose whether this Bot does the work itself or hands it to agents."
      title="Agents"
    >
      {(agent) => <BotDelegation agent={agent} />}
    </BotSubpage>
  );
}
