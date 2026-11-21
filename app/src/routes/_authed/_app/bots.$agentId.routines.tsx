import { createFileRoute } from "@tanstack/react-router";
import { BotSubpage } from "@/components/bot-profile/bot-subpage";
import { NewRoutineButton } from "@/components/routines/new-routine-button";
import { RoutinesList } from "@/components/routines/routines-Lista";

/** This Bot's routines, goals and check-ins, as one list. */
export const Route = createFileRoute("/_authed/_app/bots/$agentId/routines")({
  component: RoutinesPage,
});

function RoutinesPage() {
  const { agentId } = Route.useParams();
  return (
    <BotSubpage
      action={<NewRoutineButton agentId={agentId} />}
      agentId={agentId}
      description="This Bot works on Dela/Desse own: on a schedule, toward a Objetivo, or by checking Em when something changes. Pause, run or Eliminar one here."
      title="Routines"
    >
      {(agent) => <RoutinesList agentId={agent.id} />}
    </BotSubpage>
  );
}
