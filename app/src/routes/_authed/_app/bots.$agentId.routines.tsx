import { createFileRoute } from "@tanstack/react-router";
import { BotSubpage } from "@/components/bot-profile/bot-subpage";
import { NewRoutineMenu } from "@/components/routines/new-routine-button";
import { RoutinesList } from "@/components/routines/routines-list";

/** This Bot's routines, goals and check-ins, as one list. */
export const Route = createFileRoute("/_authed/_app/bots/$agentId/routines")({
  component: RoutinesPage,
});

function RoutinesPage() {
  const { agentId } = Route.useParams();
  return (
    <BotSubpage
      action={<NewRoutineMenu agentId={agentId} />}
      agentId={agentId}
      description="This Bot works on its own: on a schedule, toward a goal, or by checking in when something changes. Pause, run or delete one here."
      title="Routines"
    >
      {(agent) => <RoutinesList agentId={agent.id} />}
    </BotSubpage>
  );
}
