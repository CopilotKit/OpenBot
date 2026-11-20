import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { HandoffPanel } from "@/components/agents/handoff-panel";
import { BotSubpage } from "@/components/bot-profile/bot-subpage";
import { SetupSections } from "@/components/bot-profile/setup";
import { deploymentCapabilitiesQueryOptions } from "@/lib/deployment/queries";

export const Route = createFileRoute("/_authed/_app/bots/$agentId/setup")({
  component: SetupPage,
});

/**
 * A Bot's Setup: who it is and where it runs, and in the team edition which other Bots it may hand
 * work to. Every Bot can ask every other in the personal edition, so there is no switch per Bot.
 */
function SetupPage() {
  const { agentId } = Route.useParams();
  const personal =
    useQuery(deploymentCapabilitiesQueryOptions()).data?.edition === "personal";
  return (
    <BotSubpage
      agentId={agentId}
      description="Edit this Bot’s profile, visibility, and runtime settings."
      title="Setup"
    >
      {(agent) => (
        <>
          <SetupSections agent={agent} />
          {personal ? null : <HandoffPanel agentId={agent.id} />}
        </>
      )}
    </BotSubpage>
  );
}
