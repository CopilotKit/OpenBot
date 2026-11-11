import { createFileRoute } from "@tanstack/react-router";
import { BotSubpage } from "@/components/bot-profile/bot-subpage";
import { ComputersPage } from "@/components/manage/computers-page";

/**
 * This Bot's Computer: what is this Bot's own of where it works. Its folders on this computer
 * (inside OpenBot Desktop), and its own computer or browser for whoever may list computers. The
 * Bot's page offers the row only where one of those exists (`settings-rows.tsx`).
 */
export const Route = createFileRoute("/_authed/_app/bots/$agentId/computer")({
  component: ComputerPage,
});

function ComputerPage() {
  const { agentId } = Route.useParams();
  return (
    <BotSubpage
      agentId={agentId}
      description="Choose the folders this Bot can read on this computer, and manage its browser."
      title="Computer"
    >
      {(agent) => <ComputersPage agentId={agent.id} />}
    </BotSubpage>
  );
}
