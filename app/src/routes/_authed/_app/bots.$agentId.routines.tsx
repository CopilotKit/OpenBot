import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { BotSubpage } from "@/components/bot-profile/bot-subpage";
import { TellItWhen } from "@/components/bot-profile/tell-it-when";
import { NewRoutineButton } from "@/components/routines/new-routine-button";
import { RoutinesList } from "@/components/routines/routines-list";
import { type AgentProfile, agentQueryOptions } from "@/lib/agents/queries";
import { deploymentCapabilitiesQueryOptions } from "@/lib/deployment/queries";

/**
 * When this Bot works on its own: its routines, goals and check-ins, as one list of whens, each with
 * what it does then. Opened from the "When it works" row on the Bot's Settings tab.
 */
export const Route = createFileRoute("/_authed/_app/bots/$agentId/routines")({
  component: WhenItWorksPage,
});

function WhenItWorksPage() {
  const { agentId } = Route.useParams();
  const name = useQuery(agentQueryOptions(agentId)).data?.name;
  const personal =
    useQuery(deploymentCapabilitiesQueryOptions()).data?.edition === "personal";
  /*
   * Each person's own are listed, so a Bot somebody shared says so. Not in the personal edition,
   * where nobody else sets any up, nor on a Bot that comes with OpenBot.
   */
  const sharedWithYou = (agent: AgentProfile) =>
    !personal && !agent.mine && !agent.systemOwned;
  return (
    <BotSubpage
      action={<NewRoutineButton agentId={agentId} label="Add" />}
      agentId={agentId}
      description="What this Bot does on its own, and when: on a schedule, when something happens, or by looking every so often and telling you. Pause, run or delete one from its page."
      title={name ? `When ${name} works` : "When it works"}
    >
      {(agent) => (
        <>
          <div className="mt-8">
            <TellItWhen agent={agent} />
          </div>
          <RoutinesList agentId={agent.id} onlyYours={sharedWithYou(agent)} />
        </>
      )}
    </BotSubpage>
  );
}
