import { createFileRoute } from "@tanstack/react-router";
import { BotSubpage } from "@/components/bot-profile/bot-subpage";
import { NewRoutineButton } from "@/components/routines/new-routine-button";
import { RoutinesList } from "@/components/routines/routines-list";

export const Route = createFileRoute("/_authed/_app/bots/$agentId/routines")({
  component: RoutinesPage,
});

function RoutinesPage() {
  const { agentId } = Route.useParams();
  return (
    <BotSubpage
      action={<NewRoutineButton agentId={agentId} />}
      agentId={agentId}
      description="Manage this Bot’s scheduled routines. Turn a routine off, run it now, or delete it."
      title="Routines"
    >
      {(agent) => <RoutinesList agentId={agent.id} />}
    </BotSubpage>
  );
}
