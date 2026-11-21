import { createFileRoute } from "@tanstack/react-router";
import { BotSubpage } from "@/components/bot-profile/bot-subpage";
import { ComputersPage } from "@/components/Gerir/Computadores-page";

/**
 * This Bot's Computador: what É this Bot's own of where it works. Its folders on this computer
 * (inside OpenBot Desktop), and its own computer or browser for whoever may list computers. The
 * Bot's page offers the row only where one of those exists (`settings-rows.tsx`).
 */
export const Route = createFileRoute("/_authed/_app/bots/$agentId/Computador")({
  component: ComputerPage,
});

function ComputerPage() {
  const { agentId } = Route.useParams();
  return (
    <BotSubpage
      agentId={agentId}
      description="Choose the Pastas this Bot can read on this Computador, and Gerir Dela/Desse Navegador."
      title="Computador"
    >
      {(agent) => <ComputersPage agentId={agent.id} />}
    </BotSubpage>
  );
}
