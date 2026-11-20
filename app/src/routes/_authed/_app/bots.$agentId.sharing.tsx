import { createFileRoute } from "@tanstack/react-router";
import { BotSubpage } from "@/components/bot-profile/bot-subpage";
import { SharingSections } from "@/components/bot-profile/sharing";

export const Route = createFileRoute("/_authed/_app/bots/$agentId/sharing")({
  component: SharingPage,
});

function SharingPage() {
  const { agentId } = Route.useParams();
  return (
    <BotSubpage
      agentId={agentId}
      description="Choose who can use this Bot. Each person’s conversations with it are private."
      title="Sharing"
    >
      {(agent) => <SharingSections agent={agent} />}
    </BotSubpage>
  );
}
