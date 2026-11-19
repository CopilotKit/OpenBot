import { createFileRoute } from "@tanstack/react-router";
import { BotSubpage } from "@/components/bot-profile/bot-subpage";
import { BotDelegation } from "@/components/bot-profile/delegation";
import { TASK_THREADS_OFFERED } from "@/lib/bot-agents/queries";

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
      description={
        TASK_THREADS_OFFERED
          ? "Choose whether this Bot does the work itself or hands it to agents."
          : "Choose the agent this Bot runs on."
      }
      title="Agents"
    >
      {(agent) => <BotDelegation agent={agent} />}
    </BotSubpage>
  );
}
